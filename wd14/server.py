"""WD14 反推微服务 —— 给 prompt-lab NAS 版提供 NSFW 友好的图像标签。

为什么独立成一个服务（而不是塞进 Web 服务里）：
  WD14 的依赖重（onnxruntime + numpy + pillow 约 200MB），和 Node Web 服务
  耦合会让镜像臃肿、启动慢；分开后各自重启互不影响，也方便单独限内存
  （102 只有 2 核 7GB）。

接口：
  GET  /health          -> {"ok": true, "model": "...", "loaded": bool}
  POST /tags            -> {"tags": "...", "rating": "...", "scored": [...], "count": n}
       body: {"path": "/data/img/x.jpg"}  或  {"imageB64": "..."}  或 {"url": "http://..."}
       query/body 可选 threshold(0.35) / charThreshold(0.85) / top(80)

设计取舍：
  - **模型常驻内存**：446MB ONNX 加载后约 500MB RSS，102 有 6GB 可用。
    每次请求重载要 2-5 秒（Celeron 上更久），常驻才实用。
  - **单线程推理**：2 核机器上开多线程抢核反而更慢（实测 onnxruntime
    在小核数上线程同步开销明显）。用 intra_op_num_threads=2 折中。
  - **不拒答**：WD14 是 Danbooru 标签分类器，本身就是 NSFW 涵盖的，
    无需任何安全过滤 —— 这正是本服务存在的理由。
"""
import base64
import csv
import io
import json
import os
import sys
import time
import urllib.request

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import numpy as np
import onnxruntime as ort
from PIL import Image

MODEL_DIR = os.environ.get("WD14_MODEL_DIR", "/models")
MODEL_ONNX = os.path.join(MODEL_DIR, "model.onnx")
TAGS_CSV = os.path.join(MODEL_DIR, "selected_tags.csv")

# 推理线程数：102 是 2 核，默认给 2；可用 WD14_THREADS 覆盖
THREADS = int(os.environ.get("WD14_THREADS", "2"))
# 输入尺寸：WD14 (swinv2_base_window8_256) 训练用 448，**不能改**（模型固定形状）
INPUT_SIZE = int(os.environ.get("WD14_INPUT_SIZE", "448"))
# 图优化档：ALL 在 Celeron 3855U 上实测最稳（6.7s vs EXTENDED 8.9s）。
# 注意：BASIC 有时更快但波动大，ALL 稳定。可用 WD14_OPT 覆盖(basic/extended/all/disable)。
OPT_LEVEL = os.environ.get("WD14_OPT", "all").lower()

# 对出图无意义的噪声标签，默认剔除（与本地 reverse_tag.py 保持一致的思路）
DROP = {
    "commentary", "commentary_request", "translated", "bad_id", "bad_twitter_id",
    "bad_pixiv_id", "bad_deviantart_id", "bad_commentary", "twitter_username",
    "web_address", "artist_name", "username", "dated", "signature", "watermark",
}
RATING_TAGS = {"general", "sensitive", "questionable", "explicit"}

app = FastAPI(title="WD14 Tagger", version="1.0")

_state = {"session": None, "tags": [], "input_name": None, "load_seconds": None}


def load_tags(csv_path):
    """读 selected_tags.csv -> [{name, category}]。

    文件格式：tag_id,name,category,count
    category: 0=general 1=artist 3=copyright 4=character 5=meta
    """
    out = []
    with open(csv_path, encoding="utf-8") as f:
        reader = csv.reader(f)
        next(reader, None)  # 表头
        for row in reader:
            if len(row) < 3:
                continue
            try:
                cat = int(row[2])
            except (TypeError, ValueError):
                cat = 0
            out.append({"name": row[1], "category": cat})
    return out


def ensure_loaded():
    """懒加载模型（幂等）。"""
    if _state["session"] is not None:
        return _state
    if not os.path.exists(MODEL_ONNX):
        raise RuntimeError("WD14 模型缺失：%s" % MODEL_ONNX)
    if not os.path.exists(TAGS_CSV):
        raise RuntimeError("标签表缺失：%s" % TAGS_CSV)

    t0 = time.time()
    so = ort.SessionOptions()
    so.intra_op_num_threads = THREADS
    so.inter_op_num_threads = 1
    so.graph_optimization_level = {
        "disable": ort.GraphOptimizationLevel.ORT_DISABLE_ALL,
        "basic": ort.GraphOptimizationLevel.ORT_ENABLE_BASIC,
        "extended": ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED,
        "all": ort.GraphOptimizationLevel.ORT_ENABLE_ALL,
    }.get(OPT_LEVEL, ort.GraphOptimizationLevel.ORT_ENABLE_ALL)
    sess = ort.InferenceSession(MODEL_ONNX, so, providers=["CPUExecutionProvider"])
    _state.update({
        "session": sess,
        "tags": load_tags(TAGS_CSV),
        "input_name": sess.get_inputs()[0].name,
        "load_seconds": round(time.time() - t0, 2),
    })
    print("[wd14] 就绪：%d 个标签，加载 %.2fs，线程 %d，优化 %s"
          % (len(_state["tags"]), _state["load_seconds"], THREADS, OPT_LEVEL),
          file=sys.stderr, flush=True)
    return _state


def fetch_bytes(spec):
    """按 path / b64 / url 三种方式拿图片字节。"""
    if spec.path:
        with open(spec.path, "rb") as f:
            return f.read()
    if spec.imageB64:
        b = spec.imageB64
        if "," in b[:64] and b.lstrip().startswith("data:"):
            b = b.split(",", 1)[1]
        return base64.b64decode(b)
    if spec.url:
        req = urllib.request.Request(spec.url, headers={"User-Agent": "prompt-lab-wd14/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    raise HTTPException(400, "需要 path / imageB64 / url 之一")


class TagRequest(BaseModel):
    path: str | None = None
    imageB64: str | None = None
    url: str | None = None
    threshold: float = 0.35
    charThreshold: float = 0.85
    top: int = 80


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": "wd14-swinv2",
        "loaded": _state["session"] is not None,
        "loadSeconds": _state["load_seconds"],
        "threads": THREADS,
        "optLevel": OPT_LEVEL,
        "inputSize": INPUT_SIZE,
        "tagsAvailable": len(_state["tags"]),
    }


@app.post("/tags")
def tags(spec: TagRequest):
    st = ensure_loaded()
    sess, tag_list, in_name = st["session"], st["tags"], st["input_name"]

    raw = fetch_bytes(spec)
    try:
        img = Image.open(io.BytesIO(raw))
    except Exception as e:
        raise HTTPException(400, "图片解析失败：%s" % str(e)[:120])
    orig_size = list(img.size)
    if img.mode != "RGB":
        img = img.convert("RGB")
    img = img.resize((INPUT_SIZE, INPUT_SIZE), Image.BICUBIC)

    # onnx 内部自带归一化，输入用原始像素 0-255
    arr = np.asarray(img, dtype=np.float32)[None, ...]

    t0 = time.time()
    preds = sess.run(None, {in_name: arr})[0][0]
    ms = round((time.time() - t0) * 1000)

    scored, rating, rating_scores = [], "general", {}
    for i, p in enumerate(preds):
        if i >= len(tag_list):
            break
        name = tag_list[i]["name"]
        if name in RATING_TAGS:
            rating_scores[name] = float(p)
            continue
        if name in DROP:
            continue
        # 角色标签用更高阈值（避免把路人误判成角色）
        th = spec.charThreshold if tag_list[i]["category"] == 4 else spec.threshold
        if float(p) >= th:
            scored.append((name, float(p)))

    if rating_scores:
        rating = max(rating_scores, key=rating_scores.get)

    scored.sort(key=lambda x: -x[1])
    scored = scored[: max(1, int(spec.top))]

    return {
        "ok": True,
        "tags": ", ".join(n for n, _ in scored),
        "rating": rating,
        "ratingScores": {k: round(v, 4) for k, v in rating_scores.items()},
        "scored": [[n, round(s, 4)] for n, s in scored],
        "count": len(scored),
        "ms": ms,
        "imageSize": orig_size,
        "inputSize": INPUT_SIZE,
    }


@app.post("/warmup")
def warmup():
    """预加载模型（容器启动后可立即调用，避免首个请求吃加载延迟）。"""
    t0 = time.time()
    ensure_loaded()
    return {"ok": True, "loadSeconds": _state["load_seconds"],
            "totalSeconds": round(time.time() - t0, 2)}


def main():
    import uvicorn
    port = int(os.environ.get("PORT", "8199"))
    host = os.environ.get("HOST", "0.0.0.0")
    warm = os.environ.get("WD14_WARMUP", "1") not in ("0", "false", "no")
    if warm:
        try:
            ensure_loaded()
        except Exception as e:
            print("[wd14] 预热失败（会在首个请求时重试）：%s" % e,
                  file=sys.stderr, flush=True)
    print("[wd14] 监听 http://%s:%d  线程=%d  输入=%d"
          % (host, port, THREADS, INPUT_SIZE), file=sys.stderr, flush=True)
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
