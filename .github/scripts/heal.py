#!/usr/bin/env python3
"""
data-heal: 仓库数据层自愈脚本（由 GitHub Action 在每次 push 到 main 时调用）。

职责（全部幂等，可重复运行）：
  1. 以 data/artworks.json 为唯一权威，重建 data/artworks.js 快照 -> 快照永不发散；
  2. 为任何缺 medium / lqip 的作品，用 Pillow 从原图生成并写回 json；
  3. 扫描 assets/uploads(+thumbs/medium)，删除 JSON 中无对应 id 的孤儿文件；
  4. 有变化才提交（commit 带 [skip ci]，不会触发自身死循环）。

浏览器上传从此只传「原图 + json」，所有派生图/快照/清理交给本脚本，
从根本上消除「浏览器缓存旧版 main.js / 上传中途失败」导致的数据不一致。
"""
import os, json, base64, subprocess, sys
from io import BytesIO
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
os.chdir(ROOT)

JSON_PATH = "data/artworks.json"
JS_PATH = "data/artworks.js"
UP = "assets/uploads"
TH = "assets/uploads/thumbs"
MD = "assets/uploads/medium"

def log(m):
    print("[heal] " + m, flush=True)

def load_json():
    with open(JSON_PATH, encoding="utf-8") as f:
        return json.load(f)

def save_json(arr):
    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(arr, f, ensure_ascii=False, indent=2)
        f.write("\n")

def rebuild_js(arr):
    s = json.dumps(arr, ensure_ascii=False, separators=(",", ":"))
    s = s.replace("<", "\\u003c").replace(">", "\\u003e")
    with open(JS_PATH, "w", encoding="utf-8") as f:
        f.write("window.__BUILTIN__ = " + s + ";\n")

def make_webp(src_path, max_edge, quality):
    im = Image.open(src_path).convert("RGB")
    w, h = im.size
    scale = min(1.0, max_edge / max(w, h))
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    im = im.resize((nw, nh), Image.LANCZOS)
    buf = BytesIO()
    im.save(buf, "WEBP", quality=quality)
    return buf.getvalue()

def make_lqip(src_path):
    im = Image.open(src_path).convert("RGB")
    w, h = im.size
    scale = min(1.0, 32 / max(w, h))
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    im = im.resize((nw, nh), Image.LANCZOS)
    buf = BytesIO()
    im.save(buf, "WEBP", quality=70)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()

changed = False
arr = load_json()
ids = set(a["id"] for a in arr)
log("authoritative json: %d items" % len(arr))

# 1) 补齐缺 medium / lqip 的作品
for a in arr:
    i = a["id"]
    orig = os.path.join(UP, i + ".webp")
    if not os.path.exists(orig):
        log("  skip %s: original missing" % i)
        continue
    if not a.get("medium"):
        data = make_webp(orig, 1280, 85)
        with open(os.path.join(MD, i + ".webp"), "wb") as f:
            f.write(data)
        a["medium"] = "%s/%s.webp" % (MD, i)
        changed = True
        log("  generated medium for %s (%dKB)" % (i, len(data) // 1024))
    if not a.get("lqip"):
        a["lqip"] = make_lqip(orig)
        changed = True
        log("  generated lqip for %s" % i)

# 2) 重建快照（始终执行，保证永不发散）
old_js = open(JS_PATH, encoding="utf-8").read() if os.path.exists(JS_PATH) else ""
rebuild_js(arr)
if open(JS_PATH, encoding="utf-8").read() != old_js:
    changed = True
    log("  regenerated artworks.js snapshot")

# 3) 孤儿清理
def stem(n):
    return n[:-5] if n.endswith(".webp") else None

for d in (UP, TH, MD):
    if not os.path.isdir(d):
        continue
    for fn in os.listdir(d):
        s = stem(fn)
        if s is None or s in ids:
            continue
        fp = os.path.join(d, fn)
        try:
            subprocess.run(["git", "rm", "--quiet", fp], check=True)
            changed = True
            log("  removed orphan %s" % fp)
        except Exception:
            try:
                os.remove(fp)
                subprocess.run(["git", "add", fp], check=False)
                changed = True
                log("  removed untracked orphan %s" % fp)
            except Exception as e:
                log("  WARN cannot remove %s: %s" % (fp, e))

if not changed:
    log("HEAL: no changes needed (data layer already consistent)")
    sys.exit(0)

save_json(arr)
subprocess.run(["git", "add", "data/artworks.json", "data/artworks.js", UP, TH, MD], check=False)
subprocess.run(["git", "config", "user.email", "heal@mopu.local"], check=False)
subprocess.run(["git", "config", "user.name", "mopu-heal[bot]"], check=False)
r = subprocess.run(
    ["git", "commit", "-m", "chore: auto-heal data layer (snapshot/medium/lqip/orphans) [skip ci]"],
    capture_output=True, text=True,
)
if r.returncode != 0:
    log("  commit skipped/failed: " + r.stderr.strip())
    sys.exit(0)
p = subprocess.run(["git", "push"], capture_output=True, text=True)
log("  push: " + (p.stdout.strip() or p.stderr.strip()))
log("HEAL: changes committed and pushed")
