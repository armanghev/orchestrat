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

Direct browser uploads use presigned URLs, so configure the R2 bucket's CORS
policy in the Cloudflare dashboard with the exact dashboard origins:
`https://app.orchestrat.dev`, `http://localhost:5173`, and `tauri://localhost`.
Use this policy:

```json
[
  {
    "AllowedOrigins": [
      "https://app.orchestrat.dev",
      "http://localhost:5173",
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

Backfill is restartable and verifies each object before recording its byte
length and SHA-256. Garbage collection waits 24 hours before deleting an
unreferenced object or aborting an orphaned multipart upload. Capture operator
output without secrets; it reports counts, never document content or signed
URLs.

## Vercel projects

Create two separately authorized Vercel projects, only with explicit approval:

1. Set Root Directory to `apps/landing`, framework Next.js, and domain
   `orchestrat.dev`. Provide `SUPABASE_URL` and
   `SUPABASE_PUBLISHABLE_KEY` as server-side landing settings.
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
```

The migration command is intentionally not part of API startup. Stop the
service with `docker compose -f deploy/private-alpha.compose.yml down`; follow
logs with `... logs -f api`. The API also exposes `/api/v1/health`. Every
request receives an `x-request-id`; retain that ID with the timestamp when
diagnosing a failure, but redact authorization headers, cookies, database
URLs, tokens, and sensitive request bodies before sharing logs.

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

## Dashboard and native origins

The production API origin is `https://api.orchestrat.dev`; realtime uses
`wss://api.orchestrat.dev`. Supabase HTTPS/WSS origins remain allowed by the
Tauri CSP. The server inventory includes `tauri://localhost` in
`ORCHESTRAT_ALLOWED_ORIGINS` for the packaged native app, while development
localhost remains configured in the checked-in Tauri config. No data path has
been moved to Supabase PostgREST.

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

The publishable CLI requires Node.js `>=20` and bundles its SDK/MCP runtime.
After an authorized npm publication exists, the intended clean-Mac command is:

```sh
npx @orchestrat/cli@latest setup
```

That registry flow is **not currently verified**. A local build validation
alternative (not clean-Mac setup or installation testing) is:

```sh
pnpm --filter @orchestrat/cli build
node apps/cli/dist/main.js --version
```

Setup uses browser authorization, stores separate `cli`,
`agent:codex`, and `agent:claude-code` credentials in macOS Keychain, and
merges only managed Codex/Claude entries after printing a preview. The
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

Build locally with safe public build values only:

```sh
VITE_API_URL=https://api.orchestrat.dev \
ORCHESTRAT_SUPABASE_URL=https://example.supabase.co \
ORCHESTRAT_SUPABASE_PUBLISHABLE_KEY=sb_publishable_abcdefghijklmnopqrstuvwxyz123456 \
ORCHESTRAT_AUTH_ENVIRONMENT=test \
ORCHESTRAT_DESKTOP_AUTH_REDIRECT_URI=dev.orchestrat.app://auth/callback \
ORCHESTRAT_DESKTOP_AUTH_PORTAL_URL=http://localhost:5173/auth/desktop \
pnpm --filter @orchestrat/dashboard exec tauri build --no-sign
```

This is a structural unsigned/test build, not an alpha DMG build with real
production public configuration. The observed local outputs below were not
launched or auth-tested; their embedded runtime configuration is not
acceptance evidence. Outputs are under:
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
pnpm --filter @orchestrat/dashboard exec tauri build --bundles app,dmg
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
