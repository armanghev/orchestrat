# One image for a self-hosted Orchestrat: the API, which also serves the
# dashboard on the same origin. Build from the repository root:
#   docker build -f deploy/Dockerfile -t orchestrat .
FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
      --filter "@orchestrat/api..." --filter "@orchestrat/dashboard..."
# No VITE_API_URL: the dashboard talks to the origin that serves it.
RUN pnpm --filter "@orchestrat/api..." build \
 && pnpm --filter @orchestrat/dashboard build:web

FROM node:22.23.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    ORCHESTRAT_API_HOST=0.0.0.0 \
    ORCHESTRAT_API_PORT=8801 \
    ORCHESTRAT_DASHBOARD_DIR=/app/apps/dashboard/dist
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
COPY deploy/docker-entrypoint.sh /usr/local/bin/orchestrat
RUN chmod 0755 /usr/local/bin/orchestrat \
 && printf '#!/bin/sh\nexec node /app/apps/api/dist/admin.js "$@"\n' \
      > /usr/local/bin/orchestrat-admin \
 && chmod 0755 /usr/local/bin/orchestrat-admin
USER node
EXPOSE 8801
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 CMD node -e "fetch('http://127.0.0.1:'+(process.env.ORCHESTRAT_API_PORT||'8801')+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["orchestrat"]
CMD ["serve"]
