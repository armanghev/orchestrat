# orchestrat.dev

orchestrat is a macOS-first coordination plane for humans and autonomous coding
agents. It provides shared tasks, exclusive ownership, project knowledge, and
activity around agent work; it is not an agent runtime.

The private-alpha goal is to connect Codex and Claude Code to the same project
through a local Orchestrat CLI, let exactly one agent claim shared work, and make
that coordination visible in the macOS app.

## Repository layout

- `apps/landing` — Next.js marketing site for `orchestrat.dev`
- `apps/dashboard` — shared Vite + React dashboard for web and Tauri macOS
- `apps/api` — Fastify API for `api.orchestrat.dev`
- `packages/protocol` — shared Zod schemas, types, errors, and transport contracts
- `packages/ui` — small shared React primitives
- `packages/{sdk,db,mcp,auth,config,logger,testing}` — shared package boundaries
- `docs/` — architecture, product, and API documentation

## Prerequisites

- Node.js 22.22.2+ (or 24.15+)
- pnpm 10+
- a PostgreSQL connection string
- a Supabase project configured for the dashboard sign-in methods you use

## Current product status

Implemented:

- Supabase human authentication for web and Tauri, including native Keychain
  session ownership, GitHub OAuth, magic links, and deep-link callbacks
- organization and project management
- the human Tasks API, including comments, dependencies, idempotent creation,
  and optimistic concurrency
- agent credentials, sessions, heartbeat, presence, and exclusive claim APIs,
  plus the local MCP bridge
- versioned Markdown documents and lifecycle event ingestion
- private-alpha CLI setup, status, doctor, disconnect, hooks, durable managed
  runtime packaging, and read-only desktop integration status
- project-scoped realtime catch-up, dashboard synchronization, and selective
  native notifications
- private-alpha deployment manifests, Vercel app-root configuration, and
  macOS app/DMG signing preparation
- the shared web/Tauri dashboard shell

Still required for the private alpha:

- npm publication and clean-Mac CLI installation evidence
- Vercel/API deployment, DNS, hosted database migration, and backup/recovery
  evidence
- signed/notarized DMG distribution and Gatekeeper evidence
- real hosted auth, realtime, and two-agent acceptance evidence

See the [private-alpha install and operations runbook](docs/private-alpha-runbook.md)
and [clean-Mac acceptance checklist](docs/acceptance/clean-mac-two-agent-checklist.md)
for the exact external gates and current NOT RUN boundaries.

## Install and run

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

Set `ORCHESTRAT_DATABASE_URL` to the PostgreSQL connection string you provide.
The API verifies Supabase access JWTs from configured browser/native sessions.
It also requires these server-only values:

- `ORCHESTRAT_SUPABASE_URL`
- `ORCHESTRAT_SUPABASE_JWT_AUDIENCE`
- `ORCHESTRAT_SUPABASE_JWT_ALGORITHM` (`ES256` or `RS256`)

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

To create a local user, organization, and project without using the UI, set the
`ORCHESTRAT_SEED_*` variables from `.env.example`, including a stable Supabase
user UUID for `ORCHESTRAT_SEED_AUTH_SUBJECT`, then run:

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
- ⚠️ A local unsigned app/DMG build is possible; Apple signing, notarization,
  stapling, Gatekeeper assessment, and distribution remain unverified.

Known external limitations:

- npm publication, Vercel/API deployment, DNS, hosted database migration,
  Apple trust gates, and real clean-Mac acceptance require external systems and
  human authorization; none is claimed by this checkout.
- Local sandbox restrictions can block network-backed or loopback-dependent
  tests; report those as environment limitations rather than alpha evidence.

## Migration acceptance notes

- Task 3 safety boundary: all mutable session credentials stay on the Rust side in desktop (`pkce_verifier`, pending marker, refresh token, access JWT for local revoke calls only). Renderer sessions hold only short-lived `accessToken`+`expiresAtMs` grants, and are never persisted to Tauri Store.
- Verification scope used for migration handoff:
  - `cargo fmt --check`, `cargo check`, strict `clippy`, `cargo test` (native auth suites),
  - dashboard/unit and e2e test commands,
  - root `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` command matrix,
  - source + docs + lockfile + env scans for removed-provider references,
  - and callback/cross-boundary path checks in auth Rust/Web adapters.

## Architecture

The web and macOS apps share `apps/dashboard`. A persistent local CLI hosts
the generic stdio MCP bridge and lightweight hooks, storing separate agent
credentials in macOS Keychain. API transports remain thin and delegate to
application services. PostgreSQL is the durable source of truth, Drizzle owns
the reviewed migration workflow, and shared contracts live in
`@orchestrat/protocol`. Supabase identifies humans; local organization
membership controls project access.

See [architecture documentation](docs/architecture/README.md), [product documentation](docs/product/README.md), and [API documentation](docs/api/README.md).
