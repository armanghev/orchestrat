# orchestrat.dev

orchestrat is a developer-first coordination plane for humans and autonomous agents. It provides the shared workspace around agent work; it is not an agent runtime.

## Repository layout

- `apps/landing` — Next.js marketing site for `orchestrat.dev`
- `apps/dashboard` — Vite + React dashboard for web and future Tauri desktop use
- `apps/api` — Fastify API for `api.orchestrat.dev`
- `packages/protocol` — shared Zod schemas, types, errors, events, and future MCP/hook contracts
- `packages/ui` — small shared React primitives
- `packages/{sdk,db,mcp,auth,config,logger,testing}` — phase-ready shared package boundaries
- `docs/` — architecture, product, and API documentation

## Prerequisites

- Node.js 20.19+ (or 22.12+)
- pnpm 10+

## Install and run

```bash
pnpm install
pnpm dev
```

Run one surface:

```bash
pnpm dev:landing
pnpm dev:dashboard
pnpm dev:api
```

The API health endpoint is `GET http://localhost:3001/health`.

## Scripts

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

## Architecture

The dashboard and future desktop app share `apps/dashboard`. API transports remain thin and delegate to application services; PostgreSQL will be the durable source of truth once database work begins. Shared API contracts live in `@orchestrat/protocol`.

See [architecture documentation](docs/architecture/README.md), [product documentation](docs/product/README.md), and [API documentation](docs/api/README.md).
