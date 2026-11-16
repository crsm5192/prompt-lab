# WD14 反推微服务镜像
#
# 为什么用 Dockerfile 而不是 command 里 pip install：
#   1. 每次重启都装依赖（2 核机器上要 1-2 分钟），且失败就起不来
#   2. 依赖版本漂移（今天能装明天不一定）
#   3. 镜像层缓存后启动是秒级的
ARG PYTHON_IMAGE=docker.1ms.run/library/python:3.11.17-slim@sha256:b95327ce1439e687237841b0210677aeadd62d55a060a5f6bcb9c15bf6251dd3
FROM ${PYTHON_IMAGE}
WORKDIR /app

# 先单独装依赖，这样改代码不会让依赖层失效
ARG PYTHON_PACKAGE_INDEX=https://pypi.org/simple
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --index-url "$PYTHON_PACKAGE_INDEX" -r /app/requirements.txt

COPY server.py preprocess.py /app/

# 发布标识放在依赖安装后，版本变化复用已有依赖层。
ARG VCS_REF=development
ARG APP_VERSION=development
LABEL org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.version=$APP_VERSION

ENV PYTHONUNBUFFERED=1 \
    WD14_MODEL_DIR=/models \
    PORT=8199

EXPOSE 8199

# 健康检查用 python 自带 urllib，不额外装 curl 依赖
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8199/health',timeout=3).status==200 else 1)"

CMD ["python", "/app/server.py"]
