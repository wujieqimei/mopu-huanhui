import json, os
from PIL import Image

ROOT = "D:/workAI/2026-08-16-18-32-32"
SIZE = 8  # dhash 边长：生成 64-bit 哈希（9x8 灰度）

def dhash(path):
    img = Image.open(path).convert("L").resize((SIZE + 1, SIZE), Image.Resampling.LANCZOS)
    px = list(img.getdata())
    w = SIZE + 1
    bits = []
    for y in range(SIZE):
        row = px[y * w:(y + 1) * w]
        for x in range(SIZE):
            bits.append(1 if row[x] > row[x + 1] else 0)
    val = 0
    for b in bits:
        val = (val << 1) | b
    return format(val, "016x")

data = json.load(open(os.path.join(ROOT, "data", "artworks.json"), encoding="utf-8"))
out = {}
missing = []
for a in data:
    fpath = os.path.join(ROOT, a["file"])
    if os.path.isfile(fpath):
        out[a["id"]] = dhash(fpath)
    else:
        missing.append(a["id"])

with open(os.path.join(ROOT, "data", "dhashes.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=0)

print("已生成 dhashes.json，条目数:", len(out))
if missing:
    print("缺失文件(跳过):", missing)
