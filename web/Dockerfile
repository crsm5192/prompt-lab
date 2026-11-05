# 提示词工作台 Web 服务
FROM docker.1ms.run/library/node:20-alpine

WORKDIR /app

# 先装依赖（改代码不会让这层失效）
COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund

# 用通配符拷全部 .js —— 之前漏过 services.js 和 vlm.js 两次，
# 每次都是 ERR_MODULE_NOT_FOUND + 容器无限重启。
# 通配符以后加新模块不用再改这里。
COPY *.js /app/
COPY public /app/public
COPY config.json rules.json /app/

ENV NODE_ENV=production \
    PORT=33002

EXPOSE 33002

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O - http://127.0.0.1:33002/api/config >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
