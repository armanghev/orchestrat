# Orchestrat private-alpha install and operations runbook

Status: **configuration and local verification only**. This runbook does not
claim that Orchestrat is published, deployed, signed, notarized, or accepted
on a clean Mac. npm publication, Vercel/API deployment, DNS, hosted database
migration, DMG distribution, Apple trust gates, and the real two-agent
acceptance remain **NOT RUN** unless a human records external evidence.

The complete human acceptance record is the [clean-Mac two-agent
checklist](acceptance/clean-mac-two-agent-checklist.md). The no-secret
environment inventory is [`deploy/private-alpha.env.example`](../deploy/private-alpha.env.example).

## Topology and boundaries

The intended private-alpha topology is:

- `orchestrat.dev` — Vercel landing project rooted at `apps/landing`.
- `app.orchestrat.dev` — Vercel dashboard project rooted at `apps/dashboard`.
- `api.orchestrat.dev` — one persistent containerized Fastify API.
- Supabase Postgres — reached through Drizzle; application queries do not use
  Supabase PostgREST.

Keep exactly one API replica. Realtime tickets, socket registrations, and
presence state are in memory; durable project events and catch-up data remain
in PostgreSQL. Scaling the API requires a separately designed shared realtime
store and is not part of this alpha.

## Environment ownership

Copy the reviewed inventory and inject real values through the host/provider
secret store; never commit the copy:

```sh
cp deploy/private-alpha.env.example deploy/private-alpha.env
```

`ORCHESTRAT_DATABASE_URL`, `SUPABASE_S3_SECRET_ACCESS_KEY`, and
`DOCUMENT_STORAGE_S3_SECRET_ACCESS_KEY` are server secrets. The API
host/port, JWT settings, allowed origins, optional avatar and document-storage
settings, and `ORCHESTRAT_SUPABASE_URL` are server configuration/public
values. `VITE_*`, landing `SUPABASE_*` values, and the native
`ORCHESTRAT_SUPABASE_PUBLISHABLE_KEY`, auth environment, redirect URI, and
portal URL are build-public/provider or release-builder inputs. Apple signing
and notarization variables are release-builder secrets/credentials and remain
comment-only in the inventory.

Do not put database URLs, Keychain credentials, agent tokens, Apple
credentials, or private keys in client bundles, logs, screenshots, or this
repository.

## Private document storage

Use a private Cloudflare R2 bucket for document revisions and attachments only
after separate operator approval. Set `DOCUMENT_STORAGE_BUCKET` to
that bucket; keep `SUPABASE_AVATAR_BUCKET` as the separate public Supabase
bucket. The API derives immutable object keys; clients never choose keys or
receive R2 credentials.

Configure the R2 S3 endpoint as
`https://<ACCOUNT_ID>.r2.cloudflarestorage.com` and the region as
`auto`. Create a bucket-scoped R2 API token for the API host and inject its
access-key ID and secret only through the host secret store. Do not enable
public bucket access or a public custom domain for documents.
Configuration rejects bucket names embedded in the endpoint path: keep the
bucket in `DOCUMENT_STORAGE_BUCKET` and use the account origin alone for
`DOCUMENT_STORAGE_S3_ENDPOINT`.

Direct browser uploads use presigned URLs, so configure the R2 bucket's CORS
policy in the Cloudflare dashboard with the exact dashboard origins:
`https://app.orchestrat.dev`, `http://localhost:8813`, and `tauri://localhost`.
The checked-in [`deploy/document-storage-cors.json`](../deploy/document-storage-cors.json)
contains this reviewed policy:

```json
[
  {
    "AllowedOrigins": [
      "https://app.orchestrat.dev",
      "http://localhost:8813",
      "tauri://localhost"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add further methods or headers only when a browser path needs them. Verify web
and Tauri uploads in staging before release; do not use a wildcard origin. This
repository does not create or mutate the R2 bucket or its CORS policy.

The first storage release is additive: new revision bodies are dual-written
to PostgreSQL and Storage, while reads continue to support older inline-only
rows. Run and verify the restartable backfill before a later forward migration
allows null inline content. Keep existing inline bodies for one rollback
release; object-only writes and inline-body removal are separate, explicitly
authorized cutovers.

Build the API before running the storage operators. Both commands default to
dry-run; use `--apply` only after reviewing the output and receiving approval:

```sh
pnpm --filter @orchestrat/api build
pnpm --filter @orchestrat/api storage:backfill --dry-run
pnpm --filter @orchestrat/api storage:backfill --apply
pnpm --filter @orchestrat/api storage:gc --dry-run
pnpm --filter @orchestrat/api storage:gc --apply
```

Run the disposable PostgreSQL acceptance with a local or CI role allowed to
create and drop databases. Add the R2 opt-in only when the document-storage
values are already present in the environment; never paste them into the
command or logs:

```sh
ORCHESTRAT_TEST_POSTGRES_URL="$DISPOSABLE_POSTGRES_ADMIN_URL" \
  pnpm --filter @orchestrat/api test:postgres

ORCHESTRAT_TEST_POSTGRES_URL="$DISPOSABLE_POSTGRES_ADMIN_URL" \
ORCHESTRAT_TEST_R2=1 \
  pnpm --filter @orchestrat/api test:postgres
```

Backfill is restartable and verifies each object before recording its byte
length and SHA-256. Garbage collection waits 24 hours before deleting an
unreferenced object or aborting an orphaned multipart upload. Capture operator
output without secrets; it reports counts, never document content or signed
URLs.

## Vercel projects

Create two separately authorized Vercel projects, only with explicit approval:

1. Set Root Directory to `apps/landing`, framework Next.js, and domain
   `orchestrat.dev`. Provide the pooled `WAITLIST_DATABASE_URL` and
   `RESEND_API_KEY` as server-side landing settings.
2. Set Root Directory to `apps/dashboard`, framework Vite, and domain
   `app.orchestrat.dev`. The app-root [`vercel.json`](../apps/dashboard/vercel.json)
   rewrites SPA deep links to `/index.html`. Provide
   `VITE_API_URL=https://api.orchestrat.dev`, `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_PUBLISHABLE_KEY`, and
   `VITE_WEB_AUTH_CALLBACK_URL=https://app.orchestrat.dev/auth/callback`.

The checked-in Vercel files configure app-root behavior only. No Vercel
project, domain, DNS record, token, or deployment has been created by this
repository work.

## API container operations

The provider-neutral API image is `deploy/Dockerfile.api`; Compose is
`deploy/private-alpha.compose.yml`. It runs as the non-root `node` user and
keeps the migration job separate. Validate configuration before starting:

```sh
docker compose -f deploy/private-alpha.compose.yml config
docker compose -f deploy/private-alpha.compose.yml --profile migration run --rm migrate
docker compose -f deploy/private-alpha.compose.yml up -d api
docker compose -f deploy/private-alpha.compose.yml ps
docker compose -f deploy/private-alpha.compose.yml logs --tail=200 api
curl -fsS -D - -o /dev/null https://api.orchestrat.dev/health
curl -fsS -D - -o /dev/null https://api.orchestrat.dev/ready
```

The migration command is intentionally not part of API startup. `/health` is
process liveness; `/ready` also verifies a database query and is the container
health check. Versioned aliases are available under `/api/v1`. Stop the service
with `docker compose -f deploy/private-alpha.compose.yml down`; `SIGTERM` and
`SIGINT` stop new requests, drain in-flight work, close the database pool, and
force a nonzero exit if draining exceeds 10 seconds. Follow logs with
`... logs -f api`. Every request receives an `x-request-id`; retain that ID
with the timestamp when diagnosing a failure, but redact authorization
headers, cookies, database URLs, tokens, and sensitive request bodies before
sharing logs.

Public CLI authorization creation is limited to 10 requests/minute/client IP
and polling to 120/minute/client IP. Storage-heavy authenticated operations
are limited to 120/minute/resolved user or agent credential; rejected requests
return `429`, `Retry-After`, and `RATE_LIMITED`. Agent session heartbeats are
not rate-limited. These per-process, bounded limits match the required
one-replica topology. Set
`ORCHESTRAT_TRUST_PROXY_HOPS` to the exact number of controlled proxy hops that
append `X-Forwarded-For` (maximum 3); leave it `0` for direct exposure. Never
enable arbitrary proxy-header trust.

If the health check fails, inspect `docker compose ... ps`, recent API logs,
the injected env-file, database connectivity, and the one-replica constraint
before changing code. Do not run a second API replica as a workaround.

## Database backup, migration, and rollback

Before a production migration, use the provider's backup/PITR facility and
perform a restore test into a disposable database. A conventional local
backup, with the URL supplied only through the shell environment, is:

```sh
set +x
pg_dump --format=custom --file=/secure/backup/orchestrat-$(date -u +%Y%m%dT%H%M%SZ).dump "$ORCHESTRAT_DATABASE_URL"
```

Do not print the URL or commit the dump. Test restoration against a disposable
target, not the live database:

```sh
pg_restore --clean --if-exists --dbname="$ORCHESTRAT_RESTORE_DATABASE_URL" /secure/backup/orchestrat-<timestamp>.dump
```

PostgreSQL backups do not contain document Storage objects. Before a storage
cutover, take a separately tracked bucket backup or provider-approved object
copy and verify a sampled restore by key, byte length, and SHA-256. Treat the
database revision row and its immutable key as one recovery unit; restoring
only PostgreSQL can leave document bodies unavailable.

Drizzle migrations are forward-only in this repository. Review the generated
SQL, run the separate Compose migration profile, and verify `/health` and
critical reads/writes afterward. There is no fabricated `down` migration. If
an application image is incompatible, roll back to the previous image only
when its schema remains compatible, then ship a reviewed forward repair
migration. Restore the database only under the provider's recovery procedure
after confirming the blast radius and recovery point.

With explicit user approval, migration `0011` was applied to the local
PostgreSQL 18 development database using `pnpm db:migrate`. The local schema
now records 12 migrations, and all four existing human-authored tasks retained
their human creators. This is local evidence only; the hosted migration remains
**NOT RUN**.

A private local backup was created with mode `0600` and restored into an
isolated PostgreSQL 17 database. The restore contained the expected four tasks,
six document revisions, and one attachment; two restored Documents reads also
retrieved and verified their R2-backed content. No private backup contents are
part of this runbook or repository.

## Dashboard and native origins

The production API origin is `https://api.orchestrat.dev`; realtime uses
`wss://api.orchestrat.dev`. Supabase HTTPS/WSS origins remain allowed by the
Tauri CSP. The server inventory includes `tauri://localhost` in
`ORCHESTRAT_ALLOWED_ORIGINS` for the packaged native app, while development
localhost remains configured in the checked-in Tauri config. No data path has
been moved to Supabase PostgREST.

Local defaults use dedicated ports: API `8801`, dashboard `8813`, landing
`8800`, and browser tests `8814`. Existing installations must update their
`.env` values and local API URLs in `~/.orchestrat/config.json`, then restart
the API, dashboard, and agent MCP connections. Add the new dashboard callbacks
to Supabase's redirect allowlist and use the reviewed storage CORS policy.
Local HTTP is accepted only for loopback hosts.

Native release builds consume these public values:

```text
VITE_API_URL=https://api.orchestrat.dev
ORCHESTRAT_SUPABASE_URL
ORCHESTRAT_SUPABASE_PUBLISHABLE_KEY
ORCHESTRAT_AUTH_ENVIRONMENT
ORCHESTRAT_DESKTOP_AUTH_REDIRECT_URI
ORCHESTRAT_DESKTOP_AUTH_PORTAL_URL
```

## CLI install and setup

`0.1.0-alpha.2` is published under both `alpha` and `latest`. The exact registry
artifact passed hosted-alpha two-agent acceptance; see the
[release record](acceptance/2026-09-24-cli-alpha2-release.md) for evidence and the
existing-Mac testing boundary. The procedure below records the staged release
workflow; do not republish the immutable version.

The publishable CLI requires Node.js `^20.19.0 || >=22.12.0` and bundles its SDK/MCP runtime.
Earlier Node 20 releases cannot load the prompt library's `node:util.styleText`
import and are not supported.
Agent-authored tasks make `created_by_user_id` nullable, so testers must upgrade
to `0.1.0-alpha.1` before agent task creation is enabled. Older clients may
reject a task list containing an agent-authored task; no human creator is
fabricated for compatibility.

Before publication, build, pack, and install the exact alpha into a disposable
prefix. Release `0.1.0-alpha.2` includes origin-bound
credentials, safe setup writes, document folders and Markdown-path validation,
and the `RATE_LIMITED` wire error. Rebuild workspace dependencies before packing:

```sh
release_dir=$(mktemp -d /private/tmp/orchestrat-alpha.XXXXXX)
pnpm --filter @orchestrat/cli... build
pnpm --filter @orchestrat/cli pack --pack-destination "$release_dir"
npm install --prefix "$release_dir/install" \
  --cache "$release_dir/npm-cache" \
  --ignore-scripts --no-audit --no-fund \
  "$release_dir/orchestrat-cli-0.1.0-alpha.2.tgz"
scripts/acceptance/verify-cli-alpha.sh \
  "$release_dir/install/node_modules/.bin/orchestrat" 0.1.0-alpha.2
```

Publish that exact verified tarball with `npm publish <tarball> --access public
--tag alpha --ignore-scripts`. Fetch the version from npm into a fresh prefix,
verify its integrity and repeat artifact checks, then run hosted two-agent
acceptance before promoting it with `npm dist-tag add @orchestrat/cli@0.1.0-alpha.2
latest`. A failed acceptance must not advance `latest` or overwrite a version.
Record publication and live acceptance separately; a source build alone proves
neither. Hosted testing uses alpha at `api.orchestrat.dev` and
`app.orchestrat.dev`; dev credentials belong only to localhost.

After the staged npm publication exists, install or upgrade from the intended
project directory using the exact version:

```sh
npx --yes @orchestrat/cli@0.1.0-alpha.2 setup
orchestrat --version
orchestrat doctor
```

Setup refreshes the persistent launcher as well as configuring the selected
agents. Merely downloading a package does not replace an older managed runtime;
verify the launcher reports `0.1.0-alpha.2` and restart agent MCP connections.
After promotion, the default clean-Mac command is:

```sh
npx @orchestrat/cli@latest setup
```

The disposable-prefix check validates the packed artifact and bundled MCP
registry, but is not itself a clean-Mac setup test. A source build check is:

```sh
pnpm --filter @orchestrat/cli... build
node apps/cli/dist/main.js --version
```

Setup uses browser authorization, stores separate `cli:<api-origin>` and
`agent:<project-id>:<integration>:<api-origin>` credentials in macOS Keychain, and
merges only managed Codex/Claude entries after printing a preview. The
self-contained runtime ignores legacy unbound credentials: run setup again for
each intended API after upgrading an older installation; never copy a localhost
credential into a hosted credential slot. The
self-contained runtime is copied under `~/.orchestrat/runtimes`; the stable
launcher is `~/.local/bin/orchestrat`. If setup reports that `.local/bin` is
not on PATH, apply its printed command, for example:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

`orchestrat doctor` reports redacted config, mapping, credential-presence,
launcher, and backend checks. `orchestrat disconnect codex`,
`orchestrat disconnect claude-code`, or `orchestrat disconnect all` revokes
the selected backend scope before removing only managed entries and Keychain
credentials; unrelated config and existing backups are preserved. Never put
credentials in Codex/Claude files or command-line arguments.

## macOS app and DMG

The Tauri config explicitly bundles `app` and `dmg`, preserves macOS 13+, and
enables `hardenedRuntime`. No entitlements were added: the current
outside-App-Store features do not require an entitlement, and adding App
Sandbox/App Store entitlements would change the product boundary.

Build locally with safe public build values only. Always use the checked-in
`build:desktop` wrapper: it derives the native CSP from `VITE_API_URL` and
`DOCUMENT_STORAGE_S3_ENDPOINT` and accepts local HTTP only for loopback hosts.

```sh
VITE_API_URL=https://api.orchestrat.dev \
ORCHESTRAT_SUPABASE_URL=https://example.supabase.co \
ORCHESTRAT_SUPABASE_PUBLISHABLE_KEY=sb_publishable_abcdefghijklmnopqrstuvwxyz123456 \
ORCHESTRAT_AUTH_ENVIRONMENT=test \
ORCHESTRAT_DESKTOP_AUTH_REDIRECT_URI=dev.orchestrat.app://auth/callback \
ORCHESTRAT_DESKTOP_AUTH_PORTAL_URL=http://localhost:8813/auth/desktop \
DOCUMENT_STORAGE_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
pnpm --filter @orchestrat/dashboard build:desktop -- --no-sign
```

An unsigned Apple Silicon app and DMG were built locally with the actual public
API, Supabase, callback, and R2 origins. Only the sign-in screen was observed in
an earlier test build. Final hosted authentication, native R2 uploads,
notifications, signing/notarization, and clean-Mac behavior remain **NOT RUN**.
Outputs are under:
`apps/dashboard/src-tauri/target/release/bundle/macos/Orchestrat.app` and
`apps/dashboard/src-tauri/target/release/bundle/dmg/Orchestrat_0.1.0_aarch64.dmg`.
Architecture/version names may differ on another runner. An unsigned/ad-hoc
artifact is not notarized or trusted. A tester should Finder
Control-click → Open, or use System Settings → Privacy & Security to approve
the explicitly obtained app; do not use a quarantine-bypass command.

For an authorized signed release, supply Tauri's environment-driven values
only in the release environment: `APPLE_SIGNING_IDENTITY` plus either
`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, or the App Store Connect API-key
set `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`. Never commit
these values or certificate/key material.

From the repository root, an authorized signed/notarized build uses the same
Tauri environment and omits `--no-sign`:

```sh
pnpm --filter @orchestrat/dashboard build:desktop -- --bundles app,dmg
```

From the repository root, the checked-in verifier runs codesign,
Gatekeeper assessment, disk-image inspection, and stapler validation:

```sh
pnpm --filter @orchestrat/dashboard verify:macos -- \
  src-tauri/target/release/bundle/macos/Orchestrat.app \
  src-tauri/target/release/bundle/dmg/Orchestrat_0.1.0_aarch64.dmg
```

The command is expected to fail at signature/trust gates for an unsigned local
artifact. Signing, notarization, stapling, Gatekeeper trust, distribution,
and upload remain **NOT RUN**.

## Personal development verification (2026-09-09)

The existing Mac now has CLI `0.1.0-alpha.1` and the rebuilt unsigned
`/Applications/Orchestrat.app`. Local API connections were updated to `8801`;
dashboard/auth portal uses `8813`, landing uses `8800`, and browser tests use
`8814`. TCP ports stop at `65535`, so `88xxx` cannot be used. The prior app,
launcher, and connection configuration were backed up privately before the
local update. No hosted deployment or package publication was performed.

Verified against the installed application and local API:

- All 52 Turbo build/lint/typecheck/test tasks passed without cached results:
  dashboard 274 tests, CLI 66 tests, and API 67 tests with 2 opt-in skips.
- All 65 native Rust tests passed. The installed executable's SHA-256 matches
  the build output: `0f0ea12b87cb4bf8c0a9228570bee89a6092f3b5dedb1f41d1fc7b190ed2dd46`.
- Playwright passed 44 checks with 4 opt-in skips (R2 browser and waitlist at
  two viewport widths). This run did not exercise browser R2 uploads.
- The isolated real PostgreSQL/R2 suite passed all 10 checks, including
  100 MiB multipart transfer and cleanup. It created and dropped its own
  database; it did not migrate the development database.
- Installed `orchestrat doctor` passed all 70 checks. Two fresh
  installed MCP processes authenticated through separate Codex/Claude Code
  Keychain credentials and each exposed all 22 tools. Live checks passed for
  idempotent task/comment creation, stale edit conflicts, exclusive claims,
  heartbeat, completion, document history, reconnect persistence, and takeover
  after killing a process with a 30-second claim. These were stdio transport
  checks, not a clean-Mac run of the model harnesses themselves.
- The installed native app restored the existing session, showed both
  integrations Ready, displayed completed agent tasks and attributed comments,
  rendered document history, and uploaded a disposable attachment to R2.
  The QA tasks are done; the QA document and attachment are archived.

The local provider configuration gate was completed after provider sign-in:

- Supabase Site URL is `http://localhost:8813`. Redirect URLs now include
  `http://localhost:8813/auth/callback` and
  `http://localhost:8813/auth/desktop/callback`. Existing production, native,
  and legacy callback entries were retained. A fresh GitHub sign-in reached
  the authenticated project overview on port `8813`.
- Cloudflare R2 allows upload origins `http://localhost:8813` and
  `http://127.0.0.1:8814`, alongside the existing production, native, and
  legacy local origins. The policy permits `PUT` with `Content-Type`, exposes
  `ETag`, and caches preflight for 3600 seconds. The bucket remains private.
- Both new browser origins and `tauri://localhost` return preflight `204` with
  the exact matching origin; an unrelated HTTPS origin returns `403`.
- The optional R2 browser test now reads this checkout's root `.env` with
  process environment overrides and uses the current attachment chooser.
  Both viewport checks passed with actual signed R2 uploads, exact downloaded
  bytes, no browser errors, and disposable object cleanup. Re-run with
  `R2_BROWSER_E2E=1 pnpm --filter @orchestrat/dashboard test:e2e --grep @r2`.

The callback list follows [Supabase redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls);
the upload settings follow [Cloudflare R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/).
Fresh magic-link login and a new native OAuth round trip remain separate
manual checks; native session restoration and attachment upload already
passed independently.

Local evidence is in `/private/tmp/orchestrat-personal-*.log` and
`/private/tmp/orchestrat-personal-mcp-evidence.json`; the provider upload check
is in `/private/tmp/orchestrat-provider-r2-browser.log`. Those temporary files
are not release artifacts. Restart existing agent MCP connections after updating
the CLI so they load its current tool list. Use `pnpm cli:install` for future
checkout updates and the commands in [agent setup](agent-setup.md) to start
the local services.

## Earlier source candidate evidence (2026-09-06)

This evidence supports the source candidate; it does not satisfy the hosted or
clean-Mac checklist:

- Root lint, typecheck, and test commands pass. The dashboard has 274 passing
  unit tests, and the API's final Turbo run with disposable PostgreSQL has 76
  passing tests with 2 intentional skips: the external document-storage case
  and optional R2 integration. The Rust suite has 65 passing tests.
- The full Playwright suite has 44 passing tests, including two real R2 browser
  attachment workflows at both tested viewport widths.
- The operator applied the exact-origin R2 policy from
  `deploy/document-storage-cors.json`; wildcard storage origins were not used.
- Five existing R2 objects used a legacy duplicated-bucket prefix. Canonical
  copies were created and verified by byte count and SHA-256; the legacy
  objects were retained for safe rollback.
- The integrated disposable PostgreSQL plus actual R2 acceptance has 10/10
  passing subtests: legacy task/comment author migration, concurrent task and
  comment idempotency, optimistic task edits, exclusive claims, lease expiry
  takeover, dependency gating, same-base document conflicts, restartable
  backfill dry-run/apply/rerun, and attachment transfer. The attachment case
  covers a 100 MiB multipart upload, concurrent completion, exact downloaded
  bytes, single-use download tickets, and cancellation cleanup.
- The locally packed CLI `0.1.0-alpha.1` reports the expected version and its
  installed bundle passes a real stdio MCP initialize and exact tool-list
  verification. This is not npm publication evidence.
- CI defines a PostgreSQL 17 service, passes hashed test environment inputs to
  Turbo, and runs the WebKit job with its default browser fixtures. That job
  does not use R2. Real R2 and the optional waitlist test remain opt-in; the
  waitlist test runs only when the `LANDING` environment is configured.

Final hosted auth, native R2, native notifications, clean-Mac installation,
signed/notarized distribution, and pilot acceptance remain **NOT RUN**.

## Acceptance and recovery

Run the [clean-Mac checklist](acceptance/clean-mac-two-agent-checklist.md) and
its [mechanics-only harness](../scripts/acceptance/clean-mac-acceptance.sh)
before any real run. It requires a disposable hosted project, separate Codex
and Claude Code identities, real API health, and evidence with timestamps,
request IDs, and durable event sequences. It does not accept credentials or
create mock acceptance data.

For a realtime interruption, keep the API single-replica, retain the last
durable event sequence, restart the affected process, and confirm the
dashboard catches up from PostgreSQL before trusting live state. Use API
request IDs and redacted structured logs to correlate failures. Do not claim
success from a local build or a passing unit test when the hosted/auth/realtime
evidence is absent.

Explicitly skipped: public launch, App Store distribution, Windows/Linux,
multiple API replicas or Redis, billing, enterprise administration, analytics,
marketplace work, full messaging, remote MCP, and new integrations.
