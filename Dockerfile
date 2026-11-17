FROM node:22-bookworm-slim AS builder

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Europe/Paris
ENV DATA_DIR=/data
ENV PORT=3000
ENV HOST=0.0.0.0

RUN mkdir -p /data/db /data/proofs /data/replays && chown -R node:node /data /app

COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
