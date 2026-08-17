import json, base64, io, os
from PIL import Image

SIZE = 8
def dhash_bytes(raw):
    img = Image.open(io.BytesIO(raw)).convert("L").resize((SIZE+1, SIZE), Image.Resampling.LANCZOS)
    px = list(img.getdata()); w = SIZE+1; val = 0
    for y in range(SIZE):
        row = px[y*w:(y+1)*w]
        for x in range(SIZE):
            val = (val<<1) | (1 if row[x] > row[x+1] else 0)
    return format(val, "016x")

def ham(a, b):
    v = int("0x"+a, 16) ^ int("0x"+b, 16); c = 0
    while v: c += v & 1; v >>= 1
    return c

ROOT = "D:/workAI/2026-08-16-18-32-32"
exp = json.load(open("C:/Users/13000/Downloads/mopu-my-uploads.json", encoding="utf-8"))
if isinstance(exp, dict): exp = exp.get("items", exp.get("data", []))
repo_dh = json.load(open(os.path.join(ROOT, "data/dhashes.json"), encoding="utf-8"))

items = []
for e in exp:
    raw = base64.b64decode(e["dataUrl"].split(",", 1)[1])
    items.append({"id": e["id"], "title": e.get("title"), "raw": raw, "dh": dhash_bytes(raw)})

print("=== 6 张上传 与 仓库49张 比对 (hamming<=12 判定重复) ===")
for it in items:
    hits = [(rid, ham(it["dh"], rh)) for rid, rh in repo_dh.items() if ham(it["dh"], rh) <= 12]
    if hits:
        print(f"  ⚠ {it['id']} 「{it['title']}」 与仓库重复: {hits}")
    else:
        print(f"  ✓ {it['id']} 「{it['title']}」 与仓库无重复")

print("\n=== 6 张彼此之间比对 ===")
for i in range(len(items)):
    for j in range(i+1, len(items)):
        d = ham(items[i]["dh"], items[j]["dh"])
        flag = "⚠ 疑似相同图" if d <= 12 else ("~ 较相似" if d <= 20 else "✓ 不同")
        print(f"  {items[i]['title']} vs {items[j]['title']} : hamming={d} {flag}")
