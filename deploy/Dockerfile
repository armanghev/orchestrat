# One image for a self-hosted Orchestrat: the API, which also serves the
# dashboard on the same origin. Build from the repository root:
#   docker build -f deploy/Dockerfile -t orchestrat .
FROM node:22.23.2-bookworm-slim AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

FROM base AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile \
      --filter "@orchestrat/api..." --filter "@orchestrat/dashboard..."
# No VITE_API_URL: the dashboard talks to the origin that serves it.
# /dist collects the compiled output of the API and its workspace packages.
RUN pnpm --filter "@orchestrat/api..." build \
 && pnpm --filter @orchestrat/dashboard build:web \
 && for dir in $(pnpm ls -r --depth -1 --parseable --filter "@orchestrat/api..."); do \
      if [ -d "$dir/dist" ]; then mkdir -p "/dist$dir" && cp -a "$dir/dist" "/dist$dir/"; fi; \
    done

# The runtime tree in /out: the API and the workspace packages it depends on,
# with production dependencies only (no dev tools, dashboard or landing
# packages). Same lockfile and store as the build, so the versions match.
FROM base AS runtime
COPY . .
# pnpm fetch linked every package in the lockfile into node_modules/.pnpm;
# start from the store again so only the API's production closure is there.
RUN rm -rf node_modules \
 && pnpm install --offline --frozen-lockfile --prod --filter "@orchestrat/api..."
COPY --from=build /dist/app/ ./
# Each package ships whole (package.json, dist, node_modules links, and
# assets such as packages/db/drizzle) minus its sources and tests. Type
# declarations, TypeScript sources and source maps are never loaded at
# runtime: Node does not strip types under node_modules.
RUN mkdir -p /out/app \
 && cp -a package.json pnpm-workspace.yaml node_modules /out/app/ \
 && for dir in $(pnpm ls -r --depth -1 --parseable --filter "@orchestrat/api..."); do \
      mkdir -p "/out$dir" && cp -a "$dir/." "/out$dir/" \
      && rm -rf "/out$dir/src" "/out$dir/tsconfig.json" "/out$dir/dist/test" \
      && find "/out$dir" -path "/out$dir/node_modules" -prune \
           -o -type f -name '*.test.js' -exec rm -f {} +; \
    done \
 && find /out/app -type f \
      \( -name '*.map' -o -name '*.ts' -o -name '*.mts' -o -name '*.cts' \) \
      -delete \
 && test -f /out/app/packages/db/drizzle/meta/_journal.json \
 && test -f /out/app/apps/api/dist/server.js

FROM node:22.23.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    ORCHESTRAT_API_HOST=0.0.0.0 \
    ORCHESTRAT_API_PORT=8801 \
    ORCHESTRAT_DASHBOARD_DIR=/app/apps/dashboard/dist
COPY --from=runtime /out/app ./
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
