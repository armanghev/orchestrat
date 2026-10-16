# Source-available, self-hosted release plan

Status: draft, 2026-10-13. Owner: Arman.

Orchestrat stops being a hosted product. The repo becomes public, anyone runs
the whole stack themselves, and the only thing we host is orchestrat.dev
(landing + docs).

## Done means

A stranger on macOS or Linux can:

1. `docker compose up` from the repo (or a downloaded `compose.yml`)
2. open the dashboard, create the first (admin) account
3. `npx @orchestrat/cli setup --server http://localhost:8801`
4. connect Claude Code and Codex, and have them claim tasks, edit docs and chat

All of it is documented at orchestrat.dev/docs, the repo is public under the
license below, and no hosted app or API is running.

## Decisions (2026-10-13)

| Topic             | Decision                                                                         |
| ----------------- | -------------------------------------------------------------------------------- |
| Auth              | Built into the API in this release. No Supabase anywhere.                        |
| License           | Elastic License 2.0 (ELv2), see below.                                           |
| Git history       | Publish this repo as-is after one hygiene commit. No rewrite.                    |
| Finished branches | Merge `feat/org-routing` and `feat/org-integrations` first.                      |
| Desktop app       | Not in this release. Code stays; no DMG until it is ported to the new auth.      |
| Hosted app/API    | Frozen now, shut down after Arman's own data is moved to a self-hosted instance. |

### License: Elastic License 2.0

- Anyone may use, modify, redistribute and build it into their own products,
  as long as the license and notices travel with it.
- Nobody may offer Orchestrat to others as a hosted or managed service.
- Nobody may remove or obscure the license notices.
- ELv2 is not OSI-approved, so public copy says **"source-available"** and
  "free to self-host", never "open source". No OSI license can forbid hosting.
  The closest true open-source option is AGPL-3.0, which allows hosting but
  forces hosts to publish their changes, and makes embedding products AGPL too.
- Contributions require a CLA (CLA Assistant). Without one, contributed code
  arrives under ELv2 and the licensor could not host or relicense it either.
- SPDX id: `Elastic-2.0`.

### History

- The full-history scan (2026-10-13) found no credentials on any ref or in PR
  bodies.
- Old commits keep the infra IDs in the hosted-alpha acceptance docs and the
  personal author email. That is accepted.
- Future commits use the GitHub noreply address.
- Never `git push --mirror`. Local `refs/codex/*` must stay local.

## Phases

Effort: S = hours, M = a few days, L = a week or more.

### Phase 0: freeze hosted, merge finished work (S)

- [ ] Turn off auto-deploy on Railway `orchestrat-api` and Vercel
      `orchestrat-dashboard`, so merges to `main` no longer touch hosted.
      Hosted stays on today's build, and Arman keeps using it with CLI
      alpha.5 until Phase 6. (Last time a merge deployed ahead of its migration, prod broke.)
- [ ] Merge `feat/org-routing` into `main` (no migration). Run act verify and
      browser first.
- [ ] Merge `feat/org-integrations` into `main` (migration 0017). Run act
      verify and browser first.
- [ ] Remove the merged `org/*` branches and the `orchestrat-org-*` worktrees.
- [ ] Pending local changes:
  - drop the uncommitted edit to
    `docs/acceptance/2026-09-25-project-messaging.md` (it adds deployment IDs)
  - decide whether the Envy lines in `turbo.json` get committed

### Phase 1: license and repo hygiene (S)

- [ ] `LICENSE`: ELv2, licensor Arman Ghevondyan.
- [ ] `NOTICE`, covering:
  - the "Orchestrat" name and logo are not licensed
  - third-party marks: the agent logos in `apps/landing/public/logos/`
    (Anthropic, OpenAI, Anysphere, Google; files from LobeHub, with
    LobeHub's MIT notice) and the GitHub mark in
    `apps/dashboard/src/routes/auth.desktop.tsx`
  - shadcn/ui (MIT) credit for `apps/dashboard/src/components/ui/`
- [ ] `"license": "Elastic-2.0"` in the root and every workspace
      `package.json`, plus `license` and `repository` in
      `apps/dashboard/src-tauri/Cargo.toml` (fix `authors` too).
- [ ] CLI package:
  - `repository`, `homepage`, `bugs`, `author`
  - `LICENSE` and a generated `THIRD_PARTY_LICENSES` (from the esbuild
    metafile) added to `files`
  - verify the tarball with `tar tzf`
- [ ] `CONTRIBUTING.md` (CLA, dev setup, conventions from `DESIGN.md`).
- [ ] `SECURITY.md` (GitHub private vulnerability reporting).
- [ ] `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), plus issue and PR
      templates.
- [ ] Move hosted-alpha material to `local/archive/` (gitignored):
  - `docs/acceptance/*`
  - `docs/private-alpha-runbook.md`
  - `deploy/private-alpha.*`
  - `deploy/document-storage-cors.json`
- [ ] New acceptance docs may not contain infra IDs or home paths.
- [ ] Strip `/Users/...` and scratchpad paths from
      `docs/agent-attention-implementation-plan.md`.
- [ ] `.gitignore`: remove `DESIGN.md` (it is tracked) and add `.claude/`.
- [ ] Set the repo-local `git config user.email` to the noreply address.

### Phase 2: built-in auth (L), the main build

The API becomes the identity provider. Everything downstream of
`HumanAuth.authenticate` keeps working unchanged: route guards, realtime
tickets, CLI browser approval, invites and agent tokens.

**Scope for this release**

- Email and password sign-in.
- First-run setup: the first account on an empty instance becomes the
  instance admin.
- `ORCHESTRAT_SIGNUP` controls signup:
  - `invite` (default): only via existing org/project invite links
  - `open`
  - `closed`
- Account settings: change password, sign out everywhere.
- `orchestrat-admin` command in the server image, run with
  `docker compose exec orchestrat orchestrat-admin ...`:
  - `create-user`, `reset-password`, `promote`, `demote`
  - `list-users`, `revoke-sessions`
  - This covers password resets without SMTP.

**Design**

- **Passwords:**
  - `scrypt` from `node:crypto` (no native deps), per-user salt
  - timing-safe compare
  - length 10–256
  - rehash on login when the parameters change
- **Sessions:**
  - opaque random tokens (`orch_sess_…` access, `orch_refresh_…` refresh);
    only SHA-256 hashes are stored
  - access 1h; refresh 30d, rotated on use
  - reusing an old refresh token revokes the session
  - sent as `Authorization: Bearer`, so the request plumbing is unchanged
- **Endpoints**, under the existing API prefix `/api/v1/auth/`:
  - `instance` (needs_setup, signup_mode)
  - `signup`, `login`, `refresh`, `logout`, `logout-all`
  - `password`, `me`
  - rate limited per IP and per email with the existing in-memory limiter
- **Migration 0018:**
  - `user_passwords`, `auth_sessions` and `users.is_instance_admin`
  - RLS enabled with no policies
  - its `_journal.json` `when` must be greater than 0017's
- **Users:**
  - `auth_provider = 'local'`, `auth_subject = users.id`
  - existing `supabase` users (only Arman's) get claimed with
    `orchestrat-admin reset-password --email`
- **Dashboard:**
  - new screens: sign-in, create account, first-run "create admin" and
    password settings
  - `web-auth-client` calls `/v1/auth/*` instead of supabase-js
  - the auth-provider and storage shapes stay the same
- **Remove:**
  - `createSupabaseAuth` and the JWKS path in `packages/auth`
  - `ORCHESTRAT_SUPABASE_*` and `VITE_SUPABASE_*`
  - `@supabase/supabase-js`
  - the magic-link callback and the desktop OTP portal
  - the Supabase UUID in `packages/db/src/seed-config.ts`; the seed now
    creates a local user
- **Tests:**
  - replace the Supabase JWT tests with local-auth unit and real-PG tests
  - at least one Playwright spec does a real signup and login
- [ ] Run `/security-review` on the branch before it merges.

### Phase 3: self-host packaging (M)

- [ ] **One image, `ghcr.io/armanghev/orchestrat`:**
  - the API also serves the built dashboard on the same origin, with SPA
    fallback for non-API paths
  - the dashboard API base URL defaults to the same origin; `VITE_API_URL`
    remains only as an override for split dev
- [ ] **Auto-migrate on start** under a Postgres advisory lock
      (`ORCHESTRAT_MIGRATE_ON_START`, default true).
- [ ] **`deploy/compose.yml`:**
  - `postgres:17` with a volume, plus `orchestrat`
  - optional `storage` profile: MinIO plus a bucket and CORS init job
  - healthchecks
- [ ] **Init command:** `docker compose run --rm orchestrat init` writes `.env`
      with generated secrets (repository secret key and the rest).
- [ ] **One `ORCHESTRAT_PUBLIC_URL`** (replacing `ORCHESTRAT_PUBLIC_API_URL` and
      `ORCHESTRAT_DASHBOARD_URL`, which stay as fallbacks) drives:
  - CLI approval links and invite links
  - provider callbacks and webhooks
  - storage CORS
- [ ] **Generic storage settings:**
  - `ORCHESTRAT_S3_*` replaces the R2 naming and the Supabase avatar vars
  - separate internal and public endpoints (`ORCHESTRAT_S3_PUBLIC_ENDPOINT`),
    because presigned browser uploads can't reach `minio:9000` and the
    container can't reach `localhost:9000`
  - turning storage off after revisions were written to the bucket makes
    them return 503: document it, or refuse to start
  - avatar public URL is no longer `/storage/v1/object/public/`
  - `ORCHESTRAT_ATTACHMENT_QUOTA_BYTES` replaces the hardcoded 10 GiB
- [ ] **Remove the HTTPS-only checks that block local setups.** The
      Supabase ones go away with Phase 2. Loopback http stays allowed.
- [ ] **CI:**
  - a compose smoke job: boot, `/health`, signup, login, one agent call
  - multi-arch image publish (amd64, arm64) on tags
- [ ] **HTTPS:** a Caddy example in the docs (not bundled).

### Phase 4: CLI (M), runs in parallel with Phase 2

- [ ] No hosted defaults. `orchestrat setup --server <url>` prompts when the
      URL is missing and suggests `http://localhost:8801`.
      The web URL defaults to the server URL; `ORCHESTRAT_WEB_URL` stays as
      an override.
- [ ] Remove the hosted defaults in the dashboard's local-integration status
      and in `src-tauri/src/integrations.rs`.
- [ ] Linux:
  - credentials go through `secret-tool` (libsecret) when available, else a
    0600 file under `$XDG_CONFIG_HOME/orchestrat`
  - browser opens with `xdg-open`
  - hook paths verified
- [ ] Release `@orchestrat/cli` 0.1.0, which ships the license and notices.
      After the hosted shutdown, deprecate 0.1.x on npm with a pointer to the
      self-host docs.

### Phase 5: landing and docs site (M), runs in parallel from now

- [ ] **Docs:** Fumadocs inside `apps/landing` at `/docs`, with MDX under
      `apps/landing/content/docs`. Pages:
  - Introduction
  - Quickstart (compose)
  - Configuration reference (every env var)
  - Users and auth (first admin, signup modes, `orchestrat-admin`)
  - Storage (MinIO, S3, R2, CORS, proxying uploads)
  - Git providers (register your own GitHub App and GitLab app; from
    `docs/project-branches-provider-setup.md`)
  - Connect agents (CLI; from `docs/agent-setup.md`)
  - Upgrades and backups
  - Architecture
  - API reference (from `docs/api`)
  - Contributing
- [ ] **Landing, remove:**
  - the waitlist: API route, Neon/Resend libs, section, `pg` dep, env vars
  - `/pricing` and its nav and footer links
- [ ] **Landing, rewrite:**
  - CTAs: "Self-host in 5 minutes" (docs quickstart) and GitHub
  - copy in the hero, FAQ, about, `seo.ts`, `llms.txt`, `llms-full.txt` and
    the OG image: self-hosted, source-available, free
  - drop "macOS only" and the hosted-service lines
- [ ] **Legal:**
  - Privacy covers only the website and the consent-gated analytics
  - Terms cover only the website; the software is governed by ELv2
  - Footer reads "© 2026 Arman Ghevondyan · Elastic License 2.0"
- [ ] **README rewrite:**
  - what it is
  - 5-minute quickstart
  - CLI connect
  - links to the docs
  - license section
- [ ] Refresh `docs/architecture`, `docs/api` and `docs/product`, or replace
      them with links to the docs site.
- [ ] Optional: email the waitlist signups about the change.

### Phase 6: move Arman's own data off hosted (S–M)

- [ ] Run a self-hosted instance with compose.
- [ ] `pg_dump` the hosted app schema, restore it, and run migrations to
      latest.
- [ ] Copy R2 to MinIO (rclone).
- [ ] Claim the account with `orchestrat-admin reset-password`.
- [ ] Reconnect agents with CLI 0.1.0 using
      `--server http://localhost:8801`.
- [ ] Check that tasks, docs, chats, attachments and branches all survived.
- [ ] Keep the dump in `~/orchestrat-backups/`.

### Phase 7: launch and shutdown (S)

1. Get act verify, browser and compose smoke green on `main`.
2. Run a final secrets scan over the full history.
3. Repo settings:
   - description, topics, homepage
   - private vulnerability reporting
   - CLA check
   - branch protection on `main`
4. Flip the repo public.
5. Tag a release: publish the image to GHCR and `@orchestrat/cli` 0.1.0 as
   `latest`.
6. Merge the landing and docs work so Vercel deploys orchestrat.dev.
7. Announce.
8. Shut down hosted. Each step needs Arman's go-ahead:
   - Railway `orchestrat-api`
   - Vercel `orchestrat-dashboard`
   - Supabase `orchestrat-alpha`, then `orchestrat-dev` once local dev no
     longer needs it
   - the R2 bucket
   - the Neon waitlist DB
   - Resend
   - the production GitHub App
   - DNS for `app.` and `api.`: redirect `app.` to `/docs`
9. Deprecate CLI 0.1.x on npm.

## Order and lanes

```
Phase 0 ──► Phase 1 ──► Phase 2 (auth) ──► Phase 3 (packaging) ──► Phase 6 ──► Phase 7
                 └─► Phase 4 (CLI) ───────────────┘
                 └─► Phase 5 (landing/docs) ──────────────────────────────┘
```

- **Claude** (main lane): Phases 0, 2, 3, 6, 7.
- **Subagent:** Phase 1.
- **Codex:** Phase 4. The CLI only uses agent tokens and browser approval,
  so it does not wait on auth.
- **Cursor or a subagent:** Phase 5. Landing copy starts now; the auth and
  config pages wait for final env names from Phases 2 and 3.

## Ship window (proposed)

- Build: 2026-10-13 → 2026-10-31.
- Launch: 2026-11-01 → 2026-11-07.
- The WHL demo (Sat 2026-10-18) takes priority this week. Phases 0, 1 and 5
  fit around it.

## Parking lot (not this release)

- **Desktop app port:**
  - system-browser login → deep link → PKCE code exchange at the API
  - runtime server URL setting
  - signed DMG with third-party notices
- **More sign-in options:**
  - GitHub sign-in, reusing the GitHub App's user authorization
  - SMTP email: magic links, self-serve password reset, emailed invites
  - OIDC/SSO
- **Platform reach:**
  - Windows CLI support
  - GitHub Enterprise and self-managed GitLab hosts
- **Hosting and ops:**
  - local-disk storage driver, so S3 is not needed
  - instance-admin UI in the dashboard
  - multi-replica API (shared realtime and rate-limit state)
  - Helm chart and one-click deploy templates

## Risks

- **Merging to `main` while auto-deploy is on** breaks hosted. Phase 0 turns
  it off first.
- **Hand-rolled auth is security-critical.** Mitigations: scrypt, hashed
  opaque tokens, refresh rotation, rate limits, tests and a security review
  before merge.
- **ELv2 is not OSI open source**, and the launch thread may get pushback.
  Mitigations: say "source-available" everywhere and add a FAQ entry on why.
- **Presigned uploads need the browser to reach S3/MinIO.** The compose
  defaults and the storage docs must cover it.
- **Drizzle journal ordering:** 0018's `when` must exceed 0017's, or the
  migration is silently skipped.
