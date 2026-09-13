FROM oven/bun:1 AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY public ./public

RUN bun run build
RUN bun install --frozen-lockfile --production

# Runtime stays on node: impit ships a Node-ABI native addon and the
# provider child runners spawn `node` directly.
FROM node:22-slim

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json

ENV PORT=7000
ENV NODE_ENV=production
EXPOSE 7000

CMD ["node", "dist/index.js"]
