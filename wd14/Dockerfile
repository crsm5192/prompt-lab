# WD14 反推微服务镜像
#
# 为什么用 Dockerfile 而不是 command 里 pip install：
#   1. 每次重启都装依赖（2 核机器上要 1-2 分钟），且失败就起不来
#   2. 依赖版本漂移（今天能装明天不一定）
#   3. 镜像层缓存后启动是秒级的
FROM docker.1ms.run/library/python:3.11-slim

# 只装运行必需的系统包（onnxruntime 的 wheel 自带 so，无需 gcc）
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先单独装依赖，这样改代码不会让依赖层失效
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY server.py /app/server.py

ENV PYTHONUNBUFFERED=1 \
    WD14_MODEL_DIR=/models \
    PORT=8199

EXPOSE 8199

# 健康检查用 python 自带 urllib，不额外装 curl 依赖
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8199/health',timeout=3).status==200 else 1)"

CMD ["python", "/app/server.py"]
