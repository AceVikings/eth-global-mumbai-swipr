# API and worker share a backend-only image. Secrets arrive at runtime.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM deps AS build
COPY *.ts tsconfig.json ./
COPY bots ./bots
COPY providers ./providers
COPY trading ./trading
COPY ens ./ens
COPY social ./social
COPY ghosts ./ghosts
COPY passes ./passes
COPY contracts ./contracts
RUN npm run typecheck

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8787
WORKDIR /app
# tsx runs the TypeScript entry points.
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["npm", "run", "api"]
