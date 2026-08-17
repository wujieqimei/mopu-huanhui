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

/* 读取内置作品数据：图片走相对文件路径，不依赖浏览器本地库 */
async function fetchBuiltin() {
  const resp = await fetch(BUILTIN_URL);
  if (!resp.ok) throw new Error("无法读取内置作品数据 (" + resp.status + ")");
  const arr = await resp.json();
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
    const r = await fetch("data/dhashes.json");
    if (r.ok) BUILTIN_DHASHES = await r.json();
  } catch (e) { /* 忽略：不影响正常浏览 */ }
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

/* 取一条作品的可用图片地址（路径直接用，Blob 临时生成 objectURL） */
function getSrc(art) {
  if (art.src) return art.src;
  if (art.blob) return URL.createObjectURL(art.blob);
  return "";
}

/* 列表卡片用缩略图（体积小、首屏快）；无缩略图时退回原图/原 Blob */
function getThumbSrc(art) {
  if (art.thumb) return art.thumb;
  return getSrc(art);
}

/* =========================================================
   欢迎页 —— 整页点击跳转子页
   ========================================================= */
if (document.querySelector(".welcome-page")) {
  document.body.addEventListener("click", (e) => {
    if (e.target.closest(".auth") || e.target.closest(".login")) return; // 登录相关不触发跳转
    window.location.href = "gallery.html";
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
      console.error("IndexedDB 读取失败：", err);
      try { artworks = shuffleArts(await fetchBuiltin()); } // 降级：直接内存展示内置数据
      catch (e2) { artworks = []; }
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

  // 把当前浏览器里的全部作品（含图片，转 base64）导出为 JSON 文件
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
        createdAt: a.createdAt || Date.now(), dataUrl
      });
    }
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "mopu-huanhui-backup.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    alert(`已导出 ${out.length} 幅作品（图片已内嵌）为备份文件 mopu-huanhui-backup.json，请妥善保存。`);
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
        <img class="card__img" src="${getThumbSrc(art)}" alt="${art.title}" loading="lazy"${dims} />
        <div class="card__overlay">
          <div class="card__name">${art.title}</div>
          <div class="card__prompt">${art.prompt || ""}</div>
          <span class="card__tag">${art.model || "AI 作品"}</span>
        </div>
        <div class="card__tools">
          <button class="card__tool" data-act="edit" title="编辑">✏️</button>
          <button class="card__tool card__tool--del" data-act="del" title="删除">🗑</button>
        </div>`;

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
    lbImg.src = getSrc(art);
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
    const url = getSrc(currentArt);
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

    const item = { title, prompt, model };

    if (editingId) {
      // 编辑：保留原图，除非换了文件
      const orig = artworks.find((a) => a.id === editingId);
      if (file) {
        item.id = editingId; item.blob = file; item.src = null;
      } else {
        item.id = editingId;
        item.blob = orig ? orig.blob : null;
        item.src = orig ? orig.src : null;
      }
      // 编辑时保留原记录的「用户上传」标记，避免被剪枝误删
      item.userUploaded = !!(orig && orig.userUploaded);
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
      item.userUploaded = true; // 标记为「用户通过网页上传」，剪枝时跳过、永久保留
      item.createdAt = Date.now(); // 最新时间戳 → 自动排到第一位
    }

    try {
      await idbPut(item);
      closeEditor();
      await load();
    } catch (err) {
      console.error(err);
      alert("保存失败，可能是浏览器禁用了本地存储（IndexedDB）。");
    }
  });

  /* ---------- 删除 ---------- */
  async function deleteArt(art) {
    if (!isAdmin()) return; // 仅管理员可删除
    if (!confirm(`确定删除「${art.title}」？此操作不可撤销。`)) return;
    try {
      await idbDelete(art.id);
      addDeletedId(art.id); // 记入黑名单，防止 load() 合并补图时把它重新加回
      await load();
    } catch (err) {
      console.error(err);
      alert("删除失败。");
    }
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
