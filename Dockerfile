FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    WS_PUSH_INTERVAL_MS=5000

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY Routes ./Routes
COPY Data ./Data

RUN mkdir -p /app/uploads/logos && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "const port = process.env.PORT || 3000; const req = require('http').get({ host: '127.0.0.1', port, path: '/version', timeout: 5000 }, (res) => process.exit(res.statusCode === 200 ? 0 : 1)); req.on('timeout', () => req.destroy()); req.on('error', () => process.exit(1));"

CMD ["node", "server.js"]
