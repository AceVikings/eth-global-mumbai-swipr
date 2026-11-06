# One image for both backend processes: API (default) and worker (`npm run worker`).
# Node 22; PostgreSQL via `pg`. Secrets arrive as runtime env, never at build time.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8787
WORKDIR /app
# Dev dependencies stay: the api/worker scripts may run TypeScript through tsx.
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["npm", "run", "api"]
