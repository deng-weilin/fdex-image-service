FROM node:24-bookworm-slim

WORKDIR /app

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node mcp ./mcp
COPY --chown=node:node scripts ./scripts

RUN mkdir -p /app/runtime && chown node:node /app/runtime

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4310 \
    DATA_DIR=/app/runtime

EXPOSE 4310

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4310/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
