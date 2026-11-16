# 提示词工作台 Web 服务
ARG NODE_IMAGE=docker.1ms.run/library/node:24.19.0-alpine@sha256:2a49bdf71e9fd965a58c1703fd9ddd205b34e5782b692a72dd1d248abb0beb43
FROM ${NODE_IMAGE}
WORKDIR /app

# 先装依赖（改代码不会让这层失效）
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev --no-audit --no-fund

# 用通配符拷全部 .js —— 之前漏过 services.js 和 vlm.js 两次，
# 每次都是 ERR_MODULE_NOT_FOUND + 容器无限重启。
# 通配符以后加新模块不用再改这里。
COPY *.js /app/
COPY public /app/public
COPY config.json rules.json /app/

# 发布标识放在依赖安装后，版本变化复用已有依赖层。
ARG VCS_REF=development
ARG APP_VERSION=development
LABEL org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.version=$APP_VERSION

ENV NODE_ENV=production \
    PORT=33002

EXPOSE 33002

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O - http://127.0.0.1:33002/api/config >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
