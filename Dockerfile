# Build/deploy only after the owner approves hosting and publication scope.
# Official Node image. Pin its reviewed digest before an actual release.
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/bridge.sqlite
WORKDIR /app
RUN mkdir -p /data && chown node:node /data /app
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node scripts/status.js ./scripts/status.js
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/main.js"]
