#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对照画廊导出的完整备份(54张)与仓库 artworks.json(49张)，找出缺失的图并写回仓库。

用法:
  python diff_ingest.py <path-to-mopu-huanhui-backup.json>

逻辑:
  - 导出里 id 不在仓库中的条目 -> 视为「网页上传/缺失图」，解码写回仓库。
  - 导出里 id 与仓库相同但 提示词/标题/图片 不一致的 -> 标记为「可能已被编辑」，仅报告、默认不覆盖（除非 --overwrite）。
  - 写回后重新生成缩略图与 dhashes.json。
"""
import json, os, sys, base64, io, argparse
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
UPLOADS = os.path.join(ROOT, "assets", "uploads")
THUMBS = os.path.join(UPLOADS, "thumbs")
DATA = os.path.join(ROOT, "data")
ART_JSON = os.path.join(DATA, "artworks.json")
DHASH_JSON = os.path.join(DATA, "dhashes.json")
SIZE = 8


def dhash(path):
    img = Image.open(path).convert("L").resize((SIZE + 1, SIZE), Image.Resampling.LANCZOS)
    px = list(img.getdata())
    w = SIZE + 1
    val = 0
    for y in range(SIZE):
        row = px[y * w:(y + 1) * w]
        for x in range(SIZE):
            val = (val << 1) | (1 if row[x] > row[x + 1] else 0)
    return format(val, "016x")


def decode_data_url(data_url):
    _, b64 = data_url.split(",", 1)
    return base64.b64decode(b64)


def to_webp(raw, dst, max_edge=None):
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    if max_edge:
        img.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    img.save(dst, "WEBP", quality=92)
    return img.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("backup")
    ap.add_argument("--overwrite", action="store_true", help="覆盖仓库中 id 相同但内容不同的条目")
    args = ap.parse_args()

    if not os.path.isfile(args.backup):
        print("找不到文件:", args.backup); sys.exit(1)

    export = json.load(open(args.backup, encoding="utf-8"))
    if isinstance(export, dict):
        export = export.get("items", export.get("data", []))

    arts = json.load(open(ART_JSON, encoding="utf-8"))
    repo_by_id = {a["id"]: a for a in arts}
    repo_ids = set(repo_by_id)

    os.makedirs(UPLOADS, exist_ok=True)
    os.makedirs(THUMBS, exist_ok=True)

    new_items, modified = [], []
    for it in export:
        aid = it.get("id")
        if not aid:
            continue
        if aid not in repo_ids:
            new_items.append(it)
        else:
            r = repo_by_id[aid]
            diffs = []
            if (it.get("prompt") or "") != (r.get("prompt") or ""): diffs.append("prompt")
            if (it.get("title") or "") != (r.get("title") or ""): diffs.append("title")
            if it.get("dataUrl"):
                try:
                    raw = decode_data_url(it["dataUrl"])
                    h_new = dhash(io.BytesIO(raw))
                    h_old = None
                    fp = os.path.join(ROOT, r["file"])
                    if os.path.isfile(fp):
                        h_old = dhash(fp)
                    if h_new != h_old: diffs.append("image")
                except Exception as e:
                    diffs.append(f"image(err:{e})")
            if diffs:
                modified.append((aid, diffs, it))

    print(f"导出总条数: {len(export)} | 仓库条数: {len(arts)}")
    print(f"→ 仓库缺失(需写回): {len(new_items)} 张")
    for it in new_items:
        print(f"    + {it.get('id')}  「{it.get('title')}」  userUploaded={it.get('userUploaded')}")

    if modified:
        print(f"→ 与仓库 id 相同但内容不同: {len(modified)} 张（默认不覆盖，加 --overwrite 才写入）")
        for aid, diffs, _ in modified:
            print(f"    ~ {aid}  差异: {','.join(diffs)}")

    # 写回缺失的
    added = 0
    for it in new_items:
        aid = it["id"]
        if not it.get("dataUrl"):
            print("跳过(无图片):", aid); continue
        raw = decode_data_url(it["dataUrl"])
        w, h = to_webp(raw, os.path.join(UPLOADS, aid + ".webp"))
        to_webp(raw, os.path.join(THUMBS, aid + ".webp"), max_edge=480)
        rec = {
            "id": aid,
            "title": it.get("title", "未命名"),
            "prompt": it.get("prompt", ""),
            "model": it.get("model", ""),
            "year": it.get("year", ""),
            "createdAt": it.get("createdAt", int(__import__("time").time() * 1000)),
            "file": f"assets/uploads/{aid}.webp",
            "w": w, "h": h,
            "thumb": f"assets/uploads/thumbs/{aid}.webp",
        }
        arts.append(rec)
        added += 1

    # --overwrite: 覆盖内容不同的
    if args.overwrite:
        for aid, diffs, it in modified:
            if not it.get("dataUrl"): continue
            raw = decode_data_url(it["dataUrl"])
            w, h = to_webp(raw, os.path.join(UPLOADS, aid + ".webp"))
            to_webp(raw, os.path.join(THUMBS, aid + ".webp"), max_edge=480)
            r = repo_by_id[aid]
            r.update({
                "title": it.get("title", r.get("title")),
                "prompt": it.get("prompt", r.get("prompt")),
                "model": it.get("model", r.get("model", "")),
                "year": it.get("year", r.get("year", "")),
                "w": w, "h": h,
            })
            print(f"  ~ 已覆盖 {aid}")

    # 重算 dhashes
    dhashes, missing = {}, []
    for a in arts:
        fp = os.path.join(ROOT, a["file"])
        if os.path.isfile(fp):
            dhashes[a["id"]] = dhash(fp)
        else:
            missing.append(a["id"])
    json.dump(arts, open(ART_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    json.dump(dhashes, open(DHASH_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print(f"\n完成：写回 {added} 张；artworks.json 现共 {len(arts)} 条，dhashes.json {len(dhashes)} 条。")
    if missing:
        print("⚠️ 以下 id 缺图片文件:", missing)


if __name__ == "__main__":
    main()
