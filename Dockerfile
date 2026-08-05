# Node 24 runs the TypeScript sources directly (native type stripping), so
# there is no build step — copy, install runtime deps, run. Migrations live
# next to src/ and are applied by server.ts on boot.
#
# ponytail: migrate() re-runs the whole (idempotent) migration set on every
# boot with no applied-ledger, so this image is single-replica — two containers
# starting at once would race in the same schema. Add a schema_migrations
# ledger and an advisory lock around migrate() before scaling past one instance.
FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# F6: the container holds WALAO_ENC_KEY and the database credentials. Root buys
# nothing here — the app writes no files and binds an unprivileged port — so it
# is blast radius and nothing else. `node` is defined by the base image.
USER node

EXPOSE 3000

# node:24-slim ships neither curl nor wget, and installing one to answer a
# health check would be a larger surface than the check is worth. Node has fetch.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.ts"]
