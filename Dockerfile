FROM oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --ignore-scripts --production

COPY --chown=bun:bun src ./src
COPY --chown=bun:bun public ./public

ENV PORT=7000
ENV NODE_ENV=production
EXPOSE 7000

USER bun

CMD ["bun", "src/index.js"]
