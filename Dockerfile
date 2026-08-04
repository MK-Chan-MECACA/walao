# Node 24 runs the TypeScript sources directly (native type stripping), so
# there is no build step — copy, install runtime deps, run. Migrations live
# next to src/ and are applied by server.ts on boot.
FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "src/server.ts"]
