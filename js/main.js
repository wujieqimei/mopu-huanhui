/* =========================================================
   茶裙画隅 · 交互逻辑
   - 欢迎页：整页点击 → 跳转 gallery.html
   - 画廊页：本地 IndexedDB 存储，支持 上传 / 编辑 / 删除 作品
            非编辑模式：点卡片看大图（灯箱）
            编辑模式：  点卡片 / ✏️ 编辑，🗑 删除，顶栏「＋新增作品」
   ========================================================= */

/* ---------- 项目内置作品（固化在 data/artworks.json + assets/uploads/） ----------
   图片与元数据都进项目文件，任何来源 / 部署后默认可见，不再依赖浏览器本地库。
   仅首次（或仅含旧示例时）写入 IndexedDB；之后以本地编辑为准。 */
const BUILTIN_URL = "data/artworks.json";

/* 读取内置作品数据：图片走相对文件路径，不依赖浏览器本地库。
   带缓存破除参数，确保删除/上传后页面能及时反映仓库最新状态。 */
async function fetchBuiltin() {
  // 优先用 <script> 注入的全局快照（绕开沙箱对 fetch 的限制，也更稳健、省一次请求）；
  // 否则回退到 fetch 读取 data/artworks.json（带缓存破除参数）。
  let arr;
  if (window.__BUILTIN__ && Array.isArray(window.__BUILTIN__) && window.__BUILTIN__.length) {
    arr = window.__BUILTIN__;
  } else {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000); // 6s 超时兜底，防慢网挂起加载链
    const resp = await fetch(BUILTIN_URL + "?t=" + Date.now(), { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error("无法读取内置作品数据 (" + resp.status + ")");
    arr = await resp.json();
  }
  return arr.map((s) => ({
    id: s.id, title: s.title, prompt: s.prompt || "", model: s.model || "",
    year: s.year || "", createdAt: s.createdAt || 0,
    src: s.file, blob: null,
    thumb: s.thumb || null, w: s.w || 0, h: s.h || 0
  }));
}

/* ============ IndexedDB 封装 ============ */
const DB_NAME = "mopu_huanhui";
const STORE = "artworks";

/* 管理员「已删除」黑名单：持久化在 localStorage，确保删除烘焙进 json 的图后，
   不会被 load() 的「合并补图」逻辑重新加回。 */
const DELETED_KEY = "mopu_deleted_ids";
function getDeletedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(DELETED_KEY) || "[]")); }
  catch (e) { return new Set(); }
}
function addDeletedId(id) {
  const s = getDeletedIds();
  s.add(id);
  try { localStorage.setItem(DELETED_KEY, JSON.stringify([...s])); } catch (e) {}
}

/* 感知哈希（dhash）用于「禁止重复上传」：预计算已烘焙图的哈希存于 data/dhashes.json，
   上传时对新图算 dhash，与现有集合比对，汉明距离过小则判定重复并拦截。 */
let BUILTIN_DHASHES = {};
async function fetchDHashes() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000); // 4s 超时兜底，防慢网挂起加载链
    const r = await fetch("data/dhashes.json?t=" + Date.now(), { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) BUILTIN_DHASHES = await r.json();
  } catch (e) { /* 忽略：超时/失败均不影响正常浏览 */ }
}

/* 计算文件的 dhash（与 Python 端算法一致：9x8 灰度，相邻像素差分 → 64 bit） */
async function computeDHash(file) {
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const SIZE = 8;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE + 1; canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, SIZE + 1, SIZE);
  const data = ctx.getImageData(0, 0, SIZE + 1, SIZE).data;
  let bits = 0n;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * (SIZE + 1) + x) * 4;
      const p0 = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const p1 = (data[i + 4] + data[i + 5] + data[i + 6]) / 3;
      bits = (bits << 1n) | (p0 > p1 ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

/* 两个 16 位十六进制 dhash 的汉明距离 */
function hammingHex(a, b) {
  let v = BigInt("0x" + a) ^ BigInt("0x" + b);
  let c = 0n;
  while (v > 0n) { c += v & 1n; v >>= 1n; }
  return Number(c);
}

/* =========================================================
   GitHub 直写：数据落仓库（防丢失 + 实时同步）
   - 通过 GitHub Contents API 直接写文件，无需后端
   - Token 仅存浏览器 localStorage，绝不进源码
   ========================================================= */
const GH_OWNER = "wujieqimei";
const GH_REPO = "mopu-huanhui";
const GH_BRANCH = "main";
const GH_TOKEN_KEY = "mopu_gh_token";
function getGithubToken() { return localStorage.getItem(GH_TOKEN_KEY) || ""; }
function setGithubToken(t) { if (t) localStorage.setItem(GH_TOKEN_KEY, t.trim()); }
function clearGithubToken() { localStorage.removeItem(GH_TOKEN_KEY); }

/* 统一的 GitHub API 请求封装（带鉴权 + 错误处理） */
async function ghRequest(path, method, bodyObj) {
  const token = getGithubToken();
  if (!token) throw new Error("未配置 GitHub Token，无法写入仓库。点顶栏「⚙ 仓库」粘贴你的 Token。");
  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`;
  const resp = await fetch(api, {
    method,
    headers: {
      "Authorization": "token " + token,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });
  if (!resp.ok) {
    let msg = `GitHub API 错误 ${resp.status}`;
    try { const e = await resp.json(); if (e && e.message) msg += "：" + e.message; } catch (_) {}
    throw new Error(msg);
  }
  return resp.json();
}
/* 读取仓库文件：返回 {sha, text} 或 null（不存在） */
async function ghReadFile(path) {
  try {
    const d = await ghRequest(path, "GET");
    const b64 = (d.content || "").replace(/\s/g, "");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { sha: d.sha, text: new TextDecoder().decode(bytes) };
  } catch (e) {
    if (e.message && e.message.includes("404")) return null;
    throw e;
  }
}
/* 写入/更新仓库文件（contentB64 为标准 base64 字符串） */
async function ghWriteFile(path, contentB64, message, sha, attempt = 0) {
  const body = { message, content: contentB64, branch: GH_BRANCH };
  if (sha) body.sha = sha;
  try {
    return await ghRequest(path, "PUT", body);
  } catch (e) {
    // 并发写入时可能 409（sha 过期），重读最新 sha 后重试
    if (attempt < 3 && e.message && /409|冲突|Conflict/.test(e.message)) {
      const f = await ghReadFile(path);
      return ghWriteFile(path, contentB64, message, f && f.sha, attempt + 1);
    }
    throw e;
  }
}
/* 删除仓库文件 */
async function ghRemoveFile(path, sha, message) {
  return ghRequest(path, "DELETE", { message, sha, branch: GH_BRANCH });
}
/* 带重试地删除一个仓库资源：先取 sha，不存在即视为已删（返回 true）；
   遇 409/5xx/网络抖动自动重试，避免「删除中途失败留下孤儿、需后期清理」。 */
async function ghRemovePathWithRetry(path, message, attempt = 0) {
  try {
    const f = await ghReadFile(path);
    if (!f) return true; // 已不存在，视为删除成功
    await ghRemoveFile(path, f.sha, message);
    return true;
  } catch (e) {
    const transient = /409|冲突|Conflict|timeout|network|Failed to fetch|50[0-9]|ECONN|abort/i.test(e.message || "");
    if (attempt < 3 && transient) {
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      return ghRemovePathWithRetry(path, message, attempt + 1);
    }
    throw e;
  }
}
/* 读取/写入 JSON（UTF-8 安全） */
async function ghReadJson(path) {
  const f = await ghReadFile(path);
  if (!f) return null;
  return { sha: f.sha, data: JSON.parse(f.text) };
}
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
async function ghWriteJson(path, data, message, sha, attempt = 0) {
  const body = { message, content: utf8ToBase64(JSON.stringify(data, null, 2)), branch: GH_BRANCH };
  if (sha) body.sha = sha;
  try {
    return await ghRequest(path, "PUT", body);
  } catch (e) {
    if (attempt < 3 && e.message && /409|冲突|Conflict/.test(e.message)) {
      const f = await ghReadJson(path);
      return ghWriteJson(path, data, message, f && f.sha, attempt + 1);
    }
    throw e;
  }
}
/* 注意：data/artworks.js 快照不再由浏览器重建，改由 CI（.github/workflows/heal.yml）
   在每次 push 到 main 时从 data/artworks.json 自动重建，保证快照与 json 永不发散。
   画廊/画阁漫游均优先实时读取 data/artworks.json，快照仅作最后兜底。 */

/* File / Blob -> 标准 base64（去掉 data: 前缀） */
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
/* 读取图片原始尺寸 */
async function getImageSize(file) {
  const u = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = u; });
    return { w: img.naturalWidth, h: img.naturalHeight };
  } finally { URL.revokeObjectURL(u); }
}
/* 生成 webp 缩略图（最长边 800px）；同时返回原始尺寸，免去额外的图片解码 */
async function makeThumb(file, maxEdge = 800) {
  const u = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = u; });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error("缩略图生成失败")), "image/webp", 0.85);
    });
    return { blob, w: img.naturalWidth, h: img.naturalHeight };
  } finally { URL.revokeObjectURL(u); }
}

/* 把上传原图重编码为 webp q92（与原图视觉一致，但规范扩展名、体积更小、与基线一致） */
async function encodeOriginalWebp(file) {
  const u = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = u; });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error("原图编码失败")), "image/webp", 0.92);
    });
    return await blobToBase64(blob);
  } finally { URL.revokeObjectURL(u); }
}

/* 生成中等图（最长边 1280px），用于灯箱查看，避免加载数 MB 原图 */
async function makeMedium(file, maxEdge = 1280) {
  const u = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = u; });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error("中等图生成失败")), "image/webp", 0.85);
    });
    return blob;
  } finally { URL.revokeObjectURL(u); }
}

/* 生成模糊预览（LQIP，~32px webp 的 base64 data URI），用于 blur-up 瞬间铺底 */
async function makeLqip(file, maxEdge = 32) {
  const u = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = u; });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error("LQIP 生成失败")), "image/webp", 0.7);
    });
    return "data:image/webp;base64," + await blobToBase64(blob);
  } finally { URL.revokeObjectURL(u); }
}

/* 串行化所有 GitHub 写操作，避免连传多张时 artworks.json/dhashes.json 并发 409 冲突产生孤儿文件 */
let _ghChain = Promise.resolve();
function ghSerialize(task) {
  const p = _ghChain.then(() => task());
  _ghChain = p.then(() => {}, () => {}); // 无论成功失败都保持队列继续
  return p;
}

/* 把一幅作品（新增或编辑换图）写进 GitHub 仓库 */
async function pushArtworkToGithub(item, file, editingId) {
  const id = editingId || item.id;
  // 生成缩略图（同时拿到原始尺寸）+ 中等图 + 原图 base64 + 模糊预览
  const thumb = await makeThumb(file);
  const mediumBlob = await makeMedium(file);
  const origB64 = await encodeOriginalWebp(file);   // 全尺寸重编码为 webp q92，统一格式/体积
  const thumbB64 = await blobToBase64(thumb.blob);
  const mediumB64 = await blobToBase64(mediumBlob);
  const lqip = await makeLqip(file);

  // 原图/缩略图/中等图相互独立：并行读取 sha，再并行 PUT，缩短整体耗时
  const [up, th, md] = await Promise.all([
    ghReadFile(`assets/uploads/${id}.webp`),
    ghReadFile(`assets/uploads/thumbs/${id}.webp`),
    ghReadFile(`assets/uploads/medium/${id}.webp`)
  ]);
  await Promise.all([
    ghWriteFile(`assets/uploads/${id}.webp`, origB64, `upload image: ${item.title}`, up && up.sha),
    ghWriteFile(`assets/uploads/thumbs/${id}.webp`, thumbB64, `upload thumb: ${item.title}`, th && th.sha),
    ghWriteFile(`assets/uploads/medium/${id}.webp`, mediumB64, `upload medium: ${item.title}`, md && md.sha)
  ]);

  // 更新 artworks.json
  const rec = {
    id, title: item.title, prompt: item.prompt,
    model: item.model || "", year: "", createdAt: item.createdAt || Date.now(),
    file: `assets/uploads/${id}.webp`,
    thumb: `assets/uploads/thumbs/${id}.webp`,
    medium: `assets/uploads/medium/${id}.webp`,
    lqip: lqip,
    w: thumb.w, h: thumb.h
  };
  const aj = await ghReadJson("data/artworks.json");
  const arts = aj ? aj.data.slice() : [];
  const idx = arts.findIndex((a) => a.id === id);
  if (idx >= 0) arts[idx] = rec; else arts.push(rec);
  await ghWriteJson("data/artworks.json", arts, `update artworks.json: ${item.title}`, aj && aj.sha);
  // 快照（data/artworks.js）改由 CI 在每次 push 时从 json 自动重建，此处不再重建（根治快照/JSON 分歧）

  // 更新 dhashes.json（若有指纹）
  if (item.dhash) {
    const dj = await ghReadJson("data/dhashes.json");
    const map = dj ? dj.data : {};
    map[id] = item.dhash;
    await ghWriteJson("data/dhashes.json", map, `update dhashes.json: ${item.id}`, dj && dj.sha);
  }
}
/* 仅更新 artworks.json 中的文字字段（不改图） */
async function updateArtworkMetaInGithub(editingId, fields) {
  const aj = await ghReadJson("data/artworks.json");
  if (!aj) return;
  const arts = aj.data.slice();
  const idx = arts.findIndex((a) => a.id === editingId);
  if (idx < 0) return;
  arts[idx] = Object.assign({}, arts[idx], fields);
  await ghWriteJson("data/artworks.json", arts, `edit meta: ${editingId}`, aj.sha);
  // 快照由 CI 自动重建（见 .github/workflows/heal.yml），此处不再重建
}
/* 从仓库「一次处理」彻底删除一幅作品：
   - 数据层：artworks.json 剔除条目 + 重建快照 + 清理 dhashes 指纹
   - 资源层：原图 + 缩略图 + 中等图（按记录真实路径删，不再依赖后期检索清理）
   所有 GitHub 操作均带重试；资源删除尽力逐一完成，仅当仍有失败时抛出，
   由 UI 提示用户重试（本地黑名单已防作品「复活」）。 */
async function deleteArtworkFromGithub(art) {
  const id = art.id;
  // 1) 数据层：artworks.json 剔除该条目
  const aj = await ghReadJson("data/artworks.json");
  if (aj) {
    const arts = aj.data.filter((a) => a.id !== id);
    await ghWriteJson("data/artworks.json", arts, `delete: ${art.title || id}`, aj.sha);
    // 快照由 CI 在每次 push 时自动重建，删除后下一轮推送即同步，无需在此处重建
  }
  // 2) dhashes 指纹
  const dj = await ghReadJson("data/dhashes.json");
  if (dj && dj.data[id]) {
    delete dj.data[id];
    await ghWriteJson("data/dhashes.json", dj.data, `delete dhash: ${id}`, dj.sha);
  }
  // 3) 资源层：真实路径 + id 兜底，全部尽力删除（去重后逐一删）
  const rel = (p) => {
    if (!p || /^https?:\/\//i.test(p)) return null; // CDN 绝对路径无法删，交给 id 兜底
    return p.replace(/^\.?\//, "");
  };
  const paths = new Set();
  [rel(art.file), rel(art.thumb), rel(art.medium)].forEach((p) => { if (p) paths.add(p); });
  paths.add(`assets/uploads/${id}.webp`);
  paths.add(`assets/uploads/thumbs/${id}.webp`);
  paths.add(`assets/uploads/medium/${id}.webp`);

  const failures = [];
  for (const p of paths) {
    try { await ghRemovePathWithRetry(p, `delete asset: ${id}`); }
    catch (e) { failures.push(p + " (" + (e && e.message ? e.message : e) + ")"); }
  }
  if (failures.length) {
    throw new Error("部分仓库资源删除失败：" + failures.join("；") + " —— 请稍后重新删除一次以彻底清理。");
  }
}

/* 按 createdAt 倒序：最新上传排在最前 */
function sortArts(arr) {
  return arr.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/* 随机打乱，但「越新的图权重越高、越容易排在前半段」
   做法：按 createdAt 给每张图算 recency 权重(最旧的 1 倍 → 最新的 5 倍)，
   每次从剩余图里按权重随机抽取，整体随机、新图偏好靠前。 */
function shuffleArts(arr) {
  const a = arr.slice();
  const times = a.map((x) => x.createdAt || 0);
  const maxC = Math.max(...times);
  const minC = Math.min(...times);
  const range = maxC - minC || 1;
  const pool = a.map((x) => ({
    x,
    w: 1 + 9 * Math.pow((x.createdAt || 0) - minC, 2) / (range * range), // 权重 1 ~ 10，越新越高
  }));
  const out = [];
  while (pool.length) {
    const total = pool.reduce((s, o) => s + o.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      r -= pool[idx].w;
      if (r <= 0) break;
    }
    if (idx >= pool.length) idx = pool.length - 1;
    out.push(pool[idx].x);
    pool.splice(idx, 1);
  }
  return out;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGetAll() {
  return openDB().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
function idbCount() {
  return openDB().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).count();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
function idbPut(item) {
  return openDB().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}
function idbDelete(id) {
  return openDB().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}

/* ---------- jsDelivr 镜像加速 ----------
   图片/静态资源优先走国内友好的 jsDelivr CDN（github.io 国内访问慢、忽快忽慢），
   加载失败由 <img onerror> 降级回相对路径（github.io 同源）。
   注意：cdn.jsdelivr.net 对 webp 图片会 301 重定向到 raw.githubusercontent.com（国内不可达），
   故图片统一走 gcore.jsdelivr.net（200 缓存正常）；文本资源（css/js）继续用 cdn.jsdelivr.net。
   数据文件（artworks.js / dhashes.json）不走 CDN，保持实时（jsDelivr 缓存会滞后）。 */
const CDN_PREFIX = "https://gcore.jsdelivr.net/gh/wujieqimei/mopu-huanhui@main/";
function cdnUrl(p) {
  if (!p) return p;
  if (/^(https?:|blob:|data:)/.test(p)) return p; // 绝对 URL / Blob / dataURL 不动
  return CDN_PREFIX + p.replace(/^\.\//, "");
}

/* 取一条作品的可用图片地址（路径直接用，Blob 临时生成 objectURL） */
function getSrc(art) {
  const u = art.medium || art.thumb || art.src || art.file;
  if (!u) return art.blob ? URL.createObjectURL(art.blob) : "";
  return cdnUrl(u);
}

/* 列表卡片用缩略图（体积小、首屏快）；无缩略图时退回原图/原 Blob */
function getThumbSrc(art) {
  if (art.thumb) return cdnUrl(art.thumb);
  return getSrc(art);
}

/* =========================================================
   欢迎页 —— 整页点击跳转子页
   ========================================================= */
if (document.querySelector(".welcome-page")) {
  document.body.addEventListener("click", (e) => {
    if (e.target.closest(".auth") || e.target.closest(".login") ||
        e.target.closest("#petalToggle")) return; // 登录相关 / 花瓣开关不触发跳转
    window.location.href = "pavilion.html";
  });
}

/* =========================================================
   访客 / 管理员（软门槛，非真正安全认证）
   说明：纯前端静态站，密码仅作「防止随手编辑」的软门槛，
        并非真正安全认证。部署到公网前请务必改成你自己的强密码。
   ========================================================= */
const ADMIN_PASSWORD = "725725";
const ADMIN_FLAG = "mopu_admin";
let authGateOpen = false; // 暗门开关：仅你（知道暗门）可激活，激活后显示登录入口
function isAdmin() { return !!localStorage.getItem(ADMIN_FLAG); }

/* 轻量 Toast 提示（非阻塞，替代 alert，提升保存/同步时的反馈体验） */
function showToast(msg, isError) {
  let t = document.getElementById("wbToast");
  if (!t) {
    t = document.createElement("div");
    t.id = "wbToast";
    t.style.cssText = "position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:9999;max-width:90vw;padding:10px 18px;border-radius:10px;font-size:14px;line-height:1.5;box-shadow:0 6px 24px rgba(0,0,0,.18);transition:opacity .25s,transform .25s;opacity:0;pointer-events:none;";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.background = isError ? "#c0392b" : "rgba(30,30,30,.92)";
  t.style.color = "#fff";
  t.style.opacity = "1";
  t.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translateX(-50%) translateY(8px)"; }, 3400);
}

/* 同步当前页面的登录态 UI（登录按钮 / 管理员标识 / 编辑按钮） */
function applyAuth() {
  const loginBtn = document.getElementById("loginBtn");
  const userChip = document.getElementById("userChip");
  const editToggle = document.getElementById("editToggle");
  const exportBtn = document.getElementById("exportBtn");
  const importBtn = document.getElementById("importBtn");
  const admin = isAdmin();
  // 登录入口默认对访客隐藏；仅「未登录 + 暗门已激活（你自己）」才显示
  if (loginBtn) loginBtn.hidden = admin || !authGateOpen;
  if (userChip) userChip.hidden = !admin;
  if (editToggle) editToggle.hidden = !admin;
  if (exportBtn) exportBtn.hidden = !admin;
  if (importBtn) importBtn.hidden = !admin;
  const ghConfigBtn = document.getElementById("ghConfigBtn");
  if (ghConfigBtn) ghConfigBtn.hidden = !admin;
  const syncAllBtn = document.getElementById("syncAllBtn");
  if (syncAllBtn) syncAllBtn.hidden = !admin;
}

/* 暗门：调出登录入口（URL ?admin 或 连点标题 5 次触发） */
function revealAuth() {
  authGateOpen = true;
  applyAuth();
  openLogin();
}

function openLogin() {
  const m = document.getElementById("loginModal");
  const err = document.getElementById("loginErr");
  const pwd = document.getElementById("loginPwd");
  if (!m) return;
  if (err) err.hidden = true;
  if (pwd) pwd.value = "";
  m.classList.add("is-open");
  m.setAttribute("aria-hidden", "false");
  setTimeout(() => pwd && pwd.focus(), 50);
}
function closeLogin() {
  const m = document.getElementById("loginModal");
  if (!m) return;
  m.classList.remove("is-open");
  m.setAttribute("aria-hidden", "true");
}

(function bindAuth() {
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const loginModal = document.getElementById("loginModal");
  const loginForm = document.getElementById("loginForm");
  const loginPwd = document.getElementById("loginPwd");
  const loginErr = document.getElementById("loginErr");
  const loginClose = document.getElementById("loginClose");
  const loginCancel = document.getElementById("loginCancel");

  if (loginBtn) loginBtn.addEventListener("click", openLogin);
  if (loginClose) loginClose.addEventListener("click", closeLogin);
  if (loginCancel) loginCancel.addEventListener("click", closeLogin);
  if (loginModal) loginModal.addEventListener("click", (e) => { if (e.target === loginModal) closeLogin(); });
  if (loginForm) loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (loginPwd && loginPwd.value === ADMIN_PASSWORD) {
      localStorage.setItem(ADMIN_FLAG, "1");
      closeLogin();
      applyAuth();
      if (document.body.classList.contains("gallery")) location.reload();
    } else if (loginErr) {
      loginErr.hidden = false;
    }
  });
  if (logoutBtn) logoutBtn.addEventListener("click", () => {
    localStorage.removeItem(ADMIN_FLAG);
    applyAuth();
    if (document.body.classList.contains("gallery")) location.reload();
  });

  applyAuth(); // 页面加载即同步登录态

  /* 暗门 1：URL 带 ?admin → 直接调出登录入口（你私用，分享别人的链接不带此参数） */
  if (new URLSearchParams(location.search).has("admin") && !isAdmin()) revealAuth();

  /* 暗门 2：双击小标题里的「梦」字 → 弹出登录框（访客无此入口，知者方能用） */
  const dreamKey = document.getElementById("dreamKey");
  if (dreamKey) {
    dreamKey.addEventListener("click", (e) => e.stopPropagation()); // 阻止欢迎页整页点击误跳转
    dreamKey.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (!isAdmin()) revealAuth();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const m = document.getElementById("loginModal");
      if (m && m.classList.contains("is-open")) closeLogin();
    }
  });
})();

/* =========================================================
   画廊页
   ========================================================= */
(function galleryPage() {
  const grid = document.getElementById("grid");
  if (!grid) return;

  const countMeta = document.getElementById("countMeta");
  const editToggle = document.getElementById("editToggle");
  const addBar = document.getElementById("addBar");
  const addBtn = document.getElementById("addBtn");

  // 备份（导出 / 导入）—— 把困在浏览器里的作品抽成文件，避免换来源即丢失
  const exportBtn = document.getElementById("exportBtn");
  const importBtn = document.getElementById("importBtn");
  const importFile = document.getElementById("importFile");

  // 灯箱
  const lightbox = document.getElementById("lightbox");
  const lbImg = document.getElementById("lbImg");
  const lbName = document.getElementById("lbName");
  const lbModel = document.getElementById("lbModel");
  const lbPrompt = document.getElementById("lbPrompt");
  const lbClose = document.getElementById("lbClose");
  const lbPanel = document.getElementById("lightboxPanel");
  const lbDownload = document.getElementById("lbDownload");
  const lbCopy = document.getElementById("lbCopy");

  // 编辑弹窗
  const editor = document.getElementById("editor");
  const editorForm = document.getElementById("editorForm");
  const editorTitle = document.getElementById("editorTitle");
  const editorClose = document.getElementById("editorClose");
  const editorCancel = document.getElementById("editorCancel");
  const artFile = document.getElementById("artFile");
  const artTitle = document.getElementById("artTitle");
  const artPrompt = document.getElementById("artPrompt");
  const artModel = document.getElementById("artModel");
  const artPreview = document.getElementById("artPreview");

  let artworks = [];
  let editMode = false;
  let editingId = null;     // null = 新增
  let previewUrl = null;    // 编辑预览临时 URL
  let currentArt = null;     // 灯箱当前作品（供下载 / 复制提示词）

  /* ---------- 载入 ---------- */
  async function load() {
    try {
      let list = await idbGetAll();
      // 旧版本只写入了 6 张示例（id 以 seed- 开头）：检测到则清除，交给下面的合并补回真品
      const onlyOldSeed = list.length > 0 && list.every((a) => typeof a.id === "string" && a.id.startsWith("seed-"));
      if (onlyOldSeed) {
        for (const a of list) await idbDelete(a.id);
        list = await idbGetAll();
      }
      // 合并：把 data/artworks.json（已烘焙的全部作品）里、本地缺失的条目补进本地库。
      // 这样以后重新部署新增的作品，访客刷新即可自动出现，无需清空浏览器。
      const builtin = await fetchBuiltin();
      await fetchDHashes(); // 加载已烘焙图的感知哈希，供重复上传检测
      const deleted = getDeletedIds(); // 管理员已删除的 id（持久化黑名单）
      const haveIds = new Set(list.map((a) => a.id));
      let added = 0;
      for (const s of builtin) {
        if (deleted.has(s.id)) continue; // 已删除的图不再补回
        if (!haveIds.has(s.id)) {
          await idbPut({ id: s.id, title: s.title, src: s.src, prompt: s.prompt, model: s.model, year: s.year, blob: null, createdAt: s.createdAt, thumb: s.thumb, w: s.w, h: s.h });
          added++;
        }
      }
      // 剪枝：删除本地库中不在 artworks.json 里的多余条目（线上已删/去重的图），
      // 确保本地始终与线上 json 保持一致，不会残留已清理掉的记录。
      const canonicalIds = new Set(builtin.map((s) => s.id));
      let pruned = 0;
      for (const a of list) {
        if (a.userUploaded) continue; // 用户通过网页上传的图：永远保留，不参与剪枝
        if (!canonicalIds.has(a.id) || deleted.has(a.id)) {
          await idbDelete(a.id);
          pruned++;
        }
      }
      if (added > 0 || onlyOldSeed || pruned > 0 || list.length === 0) {
        list = await idbGetAll();
      }
      artworks = shuffleArts(list);
    } catch (err) {
      console.error("读取失败：", err);
      try {
        // 降级：直接内存展示内置数据，但必须套用删除黑名单，避免已删作品「复活」
        const b = await fetchBuiltin();
        const deleted = getDeletedIds();
        artworks = shuffleArts(b.filter((s) => !deleted.has(s.id)));
      } catch (e2) { artworks = []; }
    }
    render();
  }

  /* ---------- 备份：导出 / 导入 ---------- */
  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }
  async function urlToDataURL(src) {
    const resp = await fetch(src);
    const b = await resp.blob();
    return blobToDataURL(b);
  }

  // 导出浏览器里的全部作品（含图片，转 base64），用于交给管理员与仓库数据对照
  async function exportAll() {
    const list = await idbGetAll();
    const out = [];
    for (const a of list) {
      let dataUrl = "";
      try {
        if (a.blob) dataUrl = await blobToDataURL(a.blob);
        else if (a.src) dataUrl = await urlToDataURL(a.src);
      } catch (e) { console.warn("图片导出失败：", a.id, e); }
      out.push({
        id: a.id, title: a.title, prompt: a.prompt || "",
        model: a.model || "", year: a.year || "",
        createdAt: a.createdAt || Date.now(),
        userUploaded: !!a.userUploaded, dataUrl
      });
    }
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "mopu-huanhui-backup.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    alert(`已导出 ${out.length} 幅作品（图片已内嵌）为 mopu-huanhui-backup.json，交给管理员对照仓库即可。`);
  }

  // 从备份 JSON 恢复（base64 转回图片存入本地库）
  async function importAll(file) {
    const text = await file.text();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("文件格式不正确");
    let n = 0;
    for (const it of arr) {
      const item = {
        id: it.id || ("u-" + Date.now() + "-" + n),
        title: it.title, prompt: it.prompt, model: it.model, year: it.year,
        createdAt: it.createdAt || Date.now(), blob: null, src: null,
        userUploaded: true // 导入备份属于用户数据，永久保留、不参与剪枝
      };
      if (it.dataUrl) {
        item.blob = await (await fetch(it.dataUrl)).blob();
      } else if (it.src) {
        item.src = it.src;
      }
      await idbPut(item);
      n++;
    }
    await load();
    alert(`已导入 ${n} 幅作品。`);
  }

  exportBtn.addEventListener("click", () => {
    if (!isAdmin()) return; // 仅管理员可导出
    exportAll();
  });
  importBtn.addEventListener("click", () => {
    if (!isAdmin()) return; // 仅管理员可导入
    importFile.click();
  });
  importFile.addEventListener("change", async () => {
    const f = importFile.files[0];
    if (!f) return;
    if (!isAdmin()) { alert("请先以管理员身份登录后再操作。"); importFile.value = ""; return; }
    try { await importAll(f); }
    catch (e) { alert("导入失败：" + e.message); }
    importFile.value = "";
  });

  /* GitHub Token 配置（仅存本浏览器 localStorage，绝不进源码） */
  const ghConfigBtn = document.getElementById("ghConfigBtn");
  if (ghConfigBtn) ghConfigBtn.addEventListener("click", () => {
    if (!isAdmin()) return;
    const cur = getGithubToken() ? "（当前已配置）" : "（当前未配置）";
    const t = prompt(
      `GitHub Token 配置 ${cur}\n粘贴你的 Personal Access Token（仅存本浏览器，绝不写入源码）：\n点「取消」保留现状；输入 clear 可清除。`,
      getGithubToken()
    );
    if (t === null) return;
    if (t.trim().toLowerCase() === "clear") { clearGithubToken(); alert("已清除 GitHub Token。"); return; }
    if (t.trim()) { setGithubToken(t); alert("已保存 GitHub Token（仅存本浏览器）。"); }
  });

  /* ---------- ☁ 一键补同步 ----------
     把浏览器 IndexedDB 里有、但仓库 artworks.json 缺失的作品补进仓库。
     覆盖两类场景：
     a) 历史上"图已推成功、JSON 条目写失败"的半成品（有图无条的孤儿）；
     b) 未配置 Token 时期只存了本地的上传。 */
  const syncAllBtn = document.getElementById("syncAllBtn");
  if (syncAllBtn) syncAllBtn.addEventListener("click", async () => {
    if (!isAdmin()) return;
    if (!getGithubToken()) { alert("未配置 GitHub Token。点「⚙ 仓库」粘贴 Token 后再点同步。"); return; }
    syncAllBtn.disabled = true;
    const origText = syncAllBtn.textContent;
    syncAllBtn.textContent = "⏳ 同步中…";
    try {
      const list = await idbGetAll();
      const deleted = getDeletedIds();
      const aj = await ghReadJson("data/artworks.json");
      if (!aj) throw new Error("无法读取远程 data/artworks.json");
      const remoteIds = new Set(aj.data.map((a) => a.id));
      const missing = list.filter((a) => a.id && a.blob && !remoteIds.has(a.id) && !deleted.has(a.id));
      if (!missing.length) {
        showToast("仓库已是最新，无需同步（远程共 " + remoteIds.size + " 条）。");
        return;
      }
      let ok = 0, fail = 0;
      for (const a of missing) {
        try {
          await ghSerialize(() => pushArtworkToGithub(
            { id: a.id, title: a.title, prompt: a.prompt, model: a.model, createdAt: a.createdAt, dhash: a.dhash },
            a.blob, a.id
          ));
          ok++;
        } catch (e) {
          console.error("补同步失败：", a.id, e);
          fail++;
        }
      }
      showToast("同步完成：成功 " + ok + " 幅" + (fail ? "，失败 " + fail + " 幅（稍后可重点）" : "") + "。约 1 分钟后全网可见。", fail > 0);
    } catch (e) {
      showToast("同步失败：" + (e && e.message ? e.message : e), true);
    } finally {
      syncAllBtn.disabled = false;
      syncAllBtn.textContent = origText;
    }
  });

  /* ---------- 渲染瀑布流 ---------- */
  function render() {
    grid.innerHTML = "";
    countMeta.textContent = `共 ${artworks.length} 幅作品`;

    artworks.forEach((art, idx) => {
      const src = getSrc(art);
      const card = document.createElement("article");
      card.className = "card";
      card.style.animationDelay = (idx * 60) + "ms";
      const dims = (art.w && art.h) ? ` width="${art.w}" height="${art.h}"` : "";
      card.innerHTML = `
        <div class="card__media">
          <img class="card__img" src="${getThumbSrc(art)}" alt="${art.title}" loading="lazy"${dims}
               data-fb="${art.thumb || art.file || ''}"
               onerror="this.onerror=null;this.src=this.dataset.fb" />
          <div class="card__spot"></div>
        </div>
        <div class="card__cap">
          <div class="card__title">${art.title}</div>
          <div class="card__prompt">${art.prompt || ""}</div>
        </div>
        <div class="card__tools">
          <button class="card__tool" data-act="edit" title="编辑">✏️</button>
          <button class="card__tool card__tool--del" data-act="del" title="删除">🗑</button>
        </div>`;

      // 悬停聚光（#3 微交互）：光标坐标写入 CSS 变量，供 .card__spot 柔光跟随
      card.addEventListener("mousemove", (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", ((e.clientX - r.left) / r.width) * 100 + "%");
        card.style.setProperty("--my", ((e.clientY - r.top) / r.height) * 100 + "%");
      });

      // 非编辑：看大图；编辑：打开编辑表单
      card.addEventListener("click", () => {
        if (editMode) openEditor(art);
        else openLightbox(art);
      });
      card.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
        e.stopPropagation(); openEditor(art);
      });
      card.querySelector('[data-act="del"]').addEventListener("click", (e) => {
        e.stopPropagation(); deleteArt(art);
      });

      grid.appendChild(card);
    });
  }

  /* ---------- 灯箱（查看） ---------- */
  function openLightbox(art) {
    currentArt = art;
    lbImg.style.backgroundSize = "cover";
    lbImg.style.backgroundPosition = "center";
    lbImg.style.backgroundImage = (art.lqip ? "url('" + art.lqip + "')" : "");  // 模糊预览铺底
    lbImg.src = getSrc(art);
    lbImg.onerror = () => { lbImg.onerror = null; lbImg.src = art.file || art.src || ""; };
    lbImg.alt = art.title;
    lbName.textContent = art.title;
    lbModel.textContent = art.model || "—";
    lbPrompt.textContent = art.prompt || "（未填写提示词）";
    lightbox.classList.add("is-open");
    lightbox.setAttribute("aria-hidden", "false");
  }
  function closeLightbox() {
    lightbox.classList.remove("is-open");
    lightbox.setAttribute("aria-hidden", "true");
    lbImg.src = "";
  }
  lbClose.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });

  /* 灯箱操作：下载图片 / 复制提示词（访客亦可） */
  function safeName(s) { return (s || "artwork").replace(/[\\/:*?"<>|]+/g, "_").trim() || "artwork"; }
  function extOf(url) {
    const m = /\.(png|jpe?g|webp|gif|bmp)(?:[?#]|$)/i.exec(url || "");
    return m ? "." + m[1].toLowerCase() : ".png";
  }
  lbDownload.addEventListener("click", () => {
    if (!currentArt) return;
    const url = cdnUrl(currentArt.file || currentArt.medium || currentArt.src);  // 下载用全尺寸原图
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = safeName(currentArt.title) + extOf(url);
    document.body.appendChild(a); a.click(); a.remove();
  });
  let copyTimer = null;
  lbCopy.addEventListener("click", async () => {
    if (!currentArt) return;
    const text = currentArt.prompt || "";
    const flash = (msg) => {
      lbCopy.textContent = msg;
      lbCopy.classList.add("is-done");
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { lbCopy.textContent = "📋 复制提示词"; lbCopy.classList.remove("is-done"); }, 1500);
    };
    if (!text) { flash("无提示词"); return; }
    try {
      await navigator.clipboard.writeText(text);
      flash("已复制 ✅");
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); flash("已复制 ✅"); }
      catch { flash("复制失败"); }
      ta.remove();
    }
  });

  /* ---------- 编辑模式开关 ---------- */
  editToggle.addEventListener("click", () => {
    if (!isAdmin()) return; // 仅管理员可进入编辑模式
    editMode = !editMode;
    document.body.classList.toggle("is-editing", editMode);
    editToggle.textContent = editMode ? "✓ 完成" : "✏️ 编辑";
    if (!editMode) closeEditor();
  });
  addBtn.addEventListener("click", () => {
    if (!isAdmin()) return; // 仅管理员可新增
    openEditor(null);
  });

  /* ---------- 编辑 / 新增弹窗 ---------- */
  function openEditor(art) {
    editingId = art ? art.id : null;
    editorTitle.textContent = art ? "编辑作品" : "新增作品";

    artTitle.value = art ? art.title : "";
    artPrompt.value = art ? (art.prompt || "") : "";
    artModel.value = art ? (art.model || "") : "";
    artFile.value = "";

    // 预览
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    const src = art ? getSrc(art) : "";
    artPreview.innerHTML = src
      ? `<img src="${src}" alt="预览" />`
      : `<span class="editor__ph">未选择图片</span>`;

    editor.classList.add("is-open");
    editor.setAttribute("aria-hidden", "false");
  }
  function closeEditor() {
    editor.classList.remove("is-open");
    editor.setAttribute("aria-hidden", "true");
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    editingId = null;
  }
  editorClose.addEventListener("click", closeEditor);
  editorCancel.addEventListener("click", closeEditor);
  editor.addEventListener("click", (e) => { if (e.target === editor) closeEditor(); });

  // 选图即时预览
  artFile.addEventListener("change", () => {
    const f = artFile.files[0];
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    if (f) {
      previewUrl = URL.createObjectURL(f);
      artPreview.innerHTML = `<img src="${previewUrl}" alt="预览" />`;
    } else {
      artPreview.innerHTML = `<span class="editor__ph">未选择图片</span>`;
    }
  });

  // 保存
  editorForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isAdmin()) { alert("请先以管理员身份登录后再操作。"); return; }
    const title = artTitle.value.trim();
    const prompt = artPrompt.value.trim();
    const model = artModel.value.trim();
    const file = artFile.files[0];

    if (!title) { alert("请填写标题"); return; }
    if (!prompt) { alert("请填写提示词（必填）。只保留有图片和对应提示词的作品。"); return; }

    const item = { title, prompt, model, createdAt: Date.now() };
    let needPush = false, needMeta = false;

    if (editingId) {
      const orig = artworks.find((a) => a.id === editingId);
      item.id = editingId;
      if (file) {
        // 编辑且换了图：重新算 dhash 防重复（排除自身）
        try {
          const h = await computeDHash(file);
          const pool = Object.entries(BUILTIN_DHASHES)
            .filter(([k]) => k !== editingId)
            .map(([, v]) => v)
            .concat(artworks.filter((a) => a.id !== editingId && a.dhash).map((a) => a.dhash));
          let dup = false;
          for (const eh of pool) {
            if (eh && hammingHex(h, eh) <= 12) { dup = true; break; }
          }
          if (dup) { alert("⚠️ 该图片与现有作品高度相似，疑似重复上传，已禁止。如需替换请先删除原图再上传。"); return; }
          item.dhash = h;
        } catch (e) { /* 哈希失败不阻断 */ }
        item.blob = file; item.src = null;
        needPush = true; // 覆盖图 + 更新 json
      } else {
        item.blob = orig ? orig.blob : null;
        item.src = orig ? orig.src : null;
        item.dhash = orig ? orig.dhash : undefined;
        needMeta = true; // 仅改文字
      }
    } else {
      // 新增：必须选图
      if (!file) { alert("请选择作品图片"); return; }
      // 重复上传检测：算 dhash 与现有图比对，疑似重复则拦截
      try {
        const h = await computeDHash(file);
        const pool = Object.values(BUILTIN_DHASHES).concat(artworks.filter((a) => a.dhash).map((a) => a.dhash));
        let dup = false;
        for (const eh of pool) {
          if (eh && hammingHex(h, eh) <= 12) { dup = true; break; }
        }
        if (dup) { alert("⚠️ 该图片与现有作品高度相似，疑似重复上传，已禁止。如需替换请先删除原图再上传。"); return; }
        item.dhash = h; // 记录本图指纹，便于后续再上传时识别
      } catch (e) { /* 哈希失败不阻断上传，仅跳过检测 */ }
      item.id = "u-" + Date.now();
      item.blob = file; item.src = null;
      item.userUploaded = true;
      item.createdAt = Date.now(); // 最新时间戳 → 自动排到第一位
      needPush = true;
    }

    // 1) 本地立即保存并渲染：先让作品「即时出现」，GitHub 同步放到后台，避免界面卡顿
    if (editingId) {
      const i = artworks.findIndex((a) => a.id === editingId);
      if (i >= 0) {
        artworks[i] = Object.assign({}, artworks[i], {
          title, prompt, model,
          blob: item.blob, src: item.src, dhash: item.dhash,
          userUploaded: artworks[i].userUploaded || item.userUploaded
        });
      }
    } else {
      artworks.unshift(item); // 新作品置顶，立即可见
    }
    await idbPut(item);
    render();
    closeEditor();

    // 2) 后台同步到 GitHub 仓库：失败仅提示，不影响已保存的本地结果
    if (getGithubToken()) {
      showToast("已保存到本地，正在同步到 GitHub 仓库…");
      ghSerialize(async () => {
        if (needPush) await pushArtworkToGithub(item, file, editingId);
        else if (needMeta) await updateArtworkMetaInGithub(editingId, { title, prompt, model });
      }).then(() => showToast("已同步到 GitHub 仓库（约 1 分钟后全网访客可见）。"))
        .catch((err) => showToast("本地已显示；同步 GitHub 失败：" + (err && err.message ? err.message : err) + "（检查 Token 后点「☁ 同步」一键补推即可）", true));
    } else {
      showToast("已保存到本地（未配置 Token，未同步仓库）。点「⚙ 仓库」粘贴 Token 可同步。");
    }
  });

  /* ---------- 删除 ---------- */
  async function deleteArt(art) {
    if (!isAdmin()) return; // 仅管理员可删除
    if (!confirm(`确定删除「${art.title}」？将同时从本地与 GitHub 仓库移除，不可撤销。`)) return;

    // 1) 本地优先：立刻移除并刷新界面，确保「删除」即时生效，不依赖 GitHub 是否成功
    try { await idbDelete(art.id); } catch (e) { /* 本地删除尽力而为 */ }
    addDeletedId(art.id); // 黑名单：后续 load() 永不把已删图重新加回
    delete BUILTIN_DHASHES[art.id]; // 同步清理内存指纹，避免已删图被误判重复
    artworks = artworks.filter((a) => a.id !== art.id);
    render();

    // 2) 再尽力同步到 GitHub 仓库（失败也不影响本地已删除的结果）
    let msg;
    try {
      if (getGithubToken()) {
        await ghSerialize(() => deleteArtworkFromGithub(art));
        msg = "已彻底删除：原图 / 缩略图 / 中等图 / 数据 一次性清理完成（约 1 分钟后全网访客可见）。";
      } else {
        msg = "已删除本地副本。未配置 GitHub Token，仓库未同步——点「⚙ 仓库」粘贴 Token 后可同步删除仓库。";
      }
    } catch (err) {
      console.error(err);
      msg = "本地已删除，但同步 GitHub 失败：" + (err && err.message ? err.message : err) +
            "\n（本地不会再显示该作品；检查 Token 后重新删除一次即可同步仓库）";
    }
    alert(msg);

    // 本地已即时移除并持久化（删除黑名单已记录，仓库删除也已尽力同步），无需再阻塞刷新
  }

  /* ---------- 全局 ESC ---------- */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (editor.classList.contains("is-open")) closeEditor();
      else if (lightbox.classList.contains("is-open")) closeLightbox();
    }
  });

  // 启动
  applyAuth();
  load();
})();
