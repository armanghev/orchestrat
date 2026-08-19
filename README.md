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
- a PostgreSQL connection string
- a Supabase project with GitHub OAuth and email magic-link enabled

## Install and run

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

Set `ORCHESTRAT_DATABASE_URL` to the PostgreSQL connection string you provide.
The API verifies Supabase access JWTs from configured browser/native sessions.
For web builds, set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_WEB_AUTH_CALLBACK_URL`
- `VITE_API_URL`

For native desktop auth builds, set:

- `ORCHESTRAT_SUPABASE_URL`
- `ORCHESTRAT_SUPABASE_PUBLISHABLE_KEY`
- `ORCHESTRAT_AUTH_ENVIRONMENT`
- `ORCHESTRAT_DESKTOP_AUTH_REDIRECT_URI`
- `ORCHESTRAT_DESKTOP_AUTH_PORTAL_URL`

Enable GitHub OAuth and magic-link in Supabase, and add
`http://localhost:5173/auth/desktop/callback` to **Authentication → URL
Configuration → Redirect URLs**. The desktop app opens
`http://localhost:5173/auth/desktop`; the browser returns a one-time PKCE code
to the app without putting access or refresh tokens in a URL.
For production, set the portal URL to `https://app.orchestrat.dev/auth/desktop`
and allow `https://app.orchestrat.dev/auth/desktop/callback` in Supabase.

To create a local organization, workspace, and project without using the UI,
set the `ORCHESTRAT_SEED_*` variables from `.env.example`, including a stable Supabase
`auth_subject` UUID, then run:

```bash
pnpm db:seed
```

Run one surface:

```bash
pnpm dev:landing
pnpm dev:dashboard
pnpm dev:api
```

The API health endpoints are `GET http://localhost:3001/health` and
`GET http://localhost:3001/api/v1/health`.

## Scripts

```bash
pnpm build
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

### Dashboard native auth migration (Task 3)

- ✅ Native desktop auth flow and session ownership model is implemented and validated in Tauri auth service tests.
- ✅ Renderer receives only `AccessGrant` (`accessToken`, `expiresAtMs`) and does not persist refresh token/secret material.
- ✅ Required native build config is documented in `.env.example` and documented runtime vars above.
- ✅ Validation gates for missing/invalid desktop config, web callback safety, and web/native secret classification checks pass in automated suites.
- ⚠️ Packaging check in this environment cannot complete macOS DMG signing/bundling; verify `pnpm --filter @orchestrat/dashboard build:desktop` in a full macOS runner.

Known external limitations:

- JS install/build command gates are blocked here by missing network and missing binaries in `node_modules` (`turbo`, `vitest`, `playwright`, `tauri`).
- `cargo test` transport-path tests that require local socket binding report permission failures under this sandbox, so only shared/native state-machine suites are fully reliable in this runner.

## Migration acceptance notes

- Task 3 safety boundary: all mutable session credentials stay on the Rust side in desktop (`pkce_verifier`, pending marker, refresh token, access JWT for local revoke calls only). Renderer sessions hold only short-lived `accessToken`+`expiresAtMs` grants, and are never persisted to Tauri Store.
- Verification scope used for migration handoff:
  - `cargo fmt --check`, `cargo check`, strict `clippy`, `cargo test` (native auth suites),
  - dashboard/unit and e2e test commands,
  - root `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` command matrix,
  - source + docs + lockfile + env scans for removed-provider references,
  - and callback/cross-boundary path checks in auth Rust/Web adapters.

## Architecture

The dashboard and future desktop app share `apps/dashboard`. API transports
remain thin and delegate to application services. PostgreSQL is the durable
source of truth, Drizzle owns the reviewed migration workflow, and shared API
contracts live in `@orchestrat/protocol`. Supabase identifies humans; local
organization membership controls workspace and project access.

See [architecture documentation](docs/architecture/README.md), [product documentation](docs/product/README.md), and [API documentation](docs/api/README.md).
