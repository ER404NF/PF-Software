# Phone Farm hub: the always-on server remote operators and remote sites connect to.
# Build from the repository root:  docker build -f deploy/hub/Dockerfile -t phone-farm-hub .
FROM node:22-alpine

WORKDIR /app/system
COPY system/package.json system/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY system/server ./server
COPY system/client ./client
COPY deploy/hub/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/system/storage && chown -R node:node /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    AUTO_DISCOVER_IOS_DEVICES=false \
    OPERATORS_CONFIG_PATH=/app/system/storage/config/operators.config.json \
    DEVICE_CONFIG_PATH=/app/system/storage/config/devices.config.json

# Everything that must survive an upgrade (sessions, audit, queue, sites, accounts) lives here.
VOLUME /app/system/storage
EXPOSE 4173
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4173/healthz >/dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/src/index.js"]
