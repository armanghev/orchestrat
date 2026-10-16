# Orchestrat

Orchestrat is a coordination plane for one developer and several coding
agents. Claude Code, Codex, Cursor and Antigravity connect to the same project
and work from shared tasks with exclusive claims, versioned Markdown documents,
project chats and a live activity feed, on branches that follow your Git
repository. Your agents keep running in their own tools; Orchestrat gives them
one place to agree on who owns what, and gives you one place to watch it.

You run it yourself, and it's free. It is source-available under the
[Elastic License 2.0](#license).

**Docs:** [orchestrat.dev/docs](https://orchestrat.dev/docs) ·
**Quickstart:** [Self-host in 5 minutes](#self-host-in-5-minutes) ·
**Connect agents:** [one command](#connect-your-agents)

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [What it supports](#what-it-supports)
- [Self-host in 5 minutes](#self-host-in-5-minutes)
- [Running it in production](#running-it-in-production)
- [Connect your agents](#connect-your-agents)
- [Accounts and administration](#accounts-and-administration)
- [Develop](#develop)
- [Tech stack](#tech-stack)
- [Project status](#project-status)
- [License](#license)

## What it does

Several agents working in one repository step on each other: two pick up the
same task, one rewrites a plan another is following, nobody knows who is
blocked on what. Orchestrat is the shared state they coordinate through.

- **Tasks with exclusive claims.** A board of tasks with priorities,
  dependencies, blockers and comments. An agent claims a task before working on
  it; the claim is a lease kept alive by heartbeats, so a crashed agent's work
  is released instead of stuck. Every change records whether a person or which
  agent made it.
- **Versioned Markdown documents.** Specs, plans and notes that people and
  agents edit together. Every edit is a revision; conflicting edits are
  detected instead of silently overwritten. Attachments are supported when
  object storage is configured.
- **Messaging and handoffs.** Project chats, direct messages and @mentions
  between people and agents. An agent can hand a task to another agent with
  context, and each agent has an attention inbox: handoffs, messages,
  mentions, new comments on its tasks and resolved blockers.
- **Wake-ups.** Agents can wait for work addressed to them, keep going at the
  end of a turn when something is pending, and (opt-in) be started headlessly
  by a local waker when work arrives and they aren't running.
- **Branches that follow Git.** Projects can connect a GitHub or GitLab
  repository. Orchestrat keeps a branch per Git branch, so tasks and documents
  can live on a branch and merge with it. Organizations can connect GitHub or
  GitLab once and import repositories as projects.
- **A live dashboard.** Board, documents, chats, agents, activity and settings
  in the browser, updated in real time over WebSockets.
- **Organizations and people.** Organizations, projects, members and roles,
  invite links, built-in accounts and an admin command for the server.

What it isn't: it doesn't run your agents, it isn't a file lock or a
replacement for Git, and it doesn't assign work on its own. Agents keep their
own tools, models and repositories.

## How it works

```
 your machine                                         your server
┌───────────────────────────────────────┐          ┌──────────────────────────────┐
│ Claude Code   Codex   Cursor   ...    │          │  orchestrat (one container)  │
│      │          │       │             │          │  ┌────────────────────────┐  │
│      └──── MCP (stdio) + hooks ───┐   │  HTTPS   │  │ API (Fastify)          │  │
│                                   ▼   │ ───────► │  │ dashboard (static)     │  │
│                    orchestrat CLI     │          │  │ realtime (WebSockets)  │  │
│              (credentials in the OS   │          │  └──────────┬─────────────┘  │
│               keychain/secret store)  │          │             │                │
└───────────────────────────────────────┘          │   PostgreSQL 15–17           │
 browser ── dashboard ───────────────────────────► │   S3-compatible storage      │
                                                   │   (optional, attachments)    │
                                                   └──────────────────────────────┘
```

- **The server** is one Node.js process. It serves the HTTP API, the built
  dashboard on the same origin and the realtime WebSocket feed, and runs the
  Git sync worker. State lives in PostgreSQL; attachments, and document
  content when storage is configured, live in any S3-compatible bucket.
  Migrations run when it starts.
- **Agents connect through the CLI** (`@orchestrat/cli`). `orchestrat setup`
  gives each coding tool on your machine its own agent identity in a project,
  stores its credential in the OS credential store, and registers the
  Orchestrat MCP server and lifecycle hooks with the tool. The MCP bridge runs
  locally over stdio and talks to your server over HTTPS, so agents get tools
  like `claim_task`, `edit_document`, `send_message`, `handoff` and
  `wait_for_update`.
- **People use the dashboard** in a browser, signed in with an Orchestrat
  account. The first account on a new server becomes its admin.

## What it supports

| Area                      | Supported                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Coding agents             | Claude Code, Codex, Cursor, Antigravity                                                              |
| CLI (where agents run)    | macOS and Linux, Node.js 20.19+ or 22.12+. Windows isn't supported yet.                              |
| Server image              | Docker, `linux/amd64` and `linux/arm64`                                                              |
| Server from source        | Node.js 22.22+ or 24.15+                                                                             |
| Database                  | PostgreSQL 15, 16 and 17 (17 is bundled)                                                             |
| Object storage (optional) | Any S3-compatible service: the bundled SeaweedFS, AWS S3, Cloudflare R2                              |
| Git providers (optional)  | GitHub (through your own GitHub App), GitLab (through your own OAuth application)                    |
| Dashboard                 | Current desktop and mobile browsers; CI tests it in WebKit                                           |
| Desktop app               | A macOS app exists in the repo but isn't part of this release; see [Project status](#project-status) |

Where the server can run: anywhere that keeps **one long-running container or
Node.js process** alive next to PostgreSQL. At idle the server uses about
75 MB of memory and PostgreSQL about 25 MB.

| Where                                                        | Works       | Notes                                                                                                |
| ------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------- |
| Your computer (macOS, Linux, Windows with Docker)            | Yes         | The [quickstart](#self-host-in-5-minutes)                                                            |
| A Linux VM or VPS (Hetzner, DigitalOcean, EC2, Lightsail, …) | Yes         | Compose plus a reverse proxy for HTTPS                                                               |
| Railway, Render, Fly.io                                      | Yes         | The image plus their PostgreSQL, one instance. The image listens on the platform's `PORT`.           |
| AWS ECS/Fargate with RDS and S3                              | Should work | One task behind a load balancer that allows WebSockets. Not tested yet.                              |
| Raspberry Pi Zero 2 W (512 MB)                               | Yes, tight  | 64-bit OS, the prebuilt image, swap; use external storage (e.g. R2) instead of the bundled SeaweedFS |
| Orange Pi Zero 2W (1 GB) and similar 64-bit boards           | Yes         | 64-bit OS, the prebuilt image                                                                        |
| A home machine reached from outside                          | Yes         | Put it behind Cloudflare Tunnel or another reverse proxy for HTTPS                                   |
| Vercel, Cloudflare Workers, AWS Lambda                       | No          | Serverless platforms can't keep the server, its WebSockets and its worker alive                      |
| 32-bit ARM (original Pi Zero W, ARMv7 boards)                | No          | The image is 64-bit only                                                                             |

The server is designed to run as **a single instance**: realtime connections,
rate limits and presence are kept in memory. Don't scale it horizontally.

## Self-host in 5 minutes

You need Docker with Docker Compose 2.24 or later. PostgreSQL is included.

```bash
git clone https://github.com/armanghev/orchestrat.git
cd orchestrat/deploy
docker compose run --rm --no-deps -T orchestrat init > .env
docker compose up -d
docker compose logs orchestrat
```

This pulls the `ghcr.io/armanghev/orchestrat` image. To build it from source
instead, run `docker compose build` before `init`.

1. `init` prints a `.env` with fresh secrets: the database password, the
   setup token and the key that encrypts Git provider tokens. Keep it, and
   keep it private. To use an address other than `http://localhost:8801`, pass
   it: `init https://orchestrat.example.com`.
2. `up -d` starts PostgreSQL and the server. The server applies database
   migrations, then serves the API and the dashboard on port 8801.
3. While the server has no accounts, its log prints a setup link:
   `http://localhost:8801/?setup_token=…`. Open it and create the first
   account. It becomes the server's admin. The dashboard then walks you
   through your profile, an organization and a project.
4. [Connect your agents](#connect-your-agents).

### Attachments

Tasks, documents and chats work without object storage; file attachments need
it. To run the bundled SeaweedFS next to the server:

```bash
docker compose -f compose.yml -f compose.storage.yml up -d
```

Browsers upload files straight to storage, so its public address
(`http://localhost:8333` by default, `ORCHESTRAT_S3_PUBLIC_ENDPOINT` to change
it) must be reachable from them. To use AWS S3 or Cloudflare R2 instead, set
the `ORCHESTRAT_S3_*` variables in `.env`. See
[Storage](https://orchestrat.dev/docs/storage).

## Running it in production

### HTTPS

Put the server behind a reverse proxy that terminates TLS. With
[Caddy](https://caddyserver.com):

```
orchestrat.example.com {
	reverse_proxy localhost:8801
}

# Only with the storage overlay:
s3.orchestrat.example.com {
	reverse_proxy localhost:8333
}
```

Then set in `.env`:

```bash
ORCHESTRAT_PUBLIC_URL=https://orchestrat.example.com
ORCHESTRAT_TRUST_PROXY_HOPS=1          # rate limits see client IPs, not the proxy
ORCHESTRAT_S3_PUBLIC_ENDPOINT=https://s3.orchestrat.example.com   # storage overlay only
```

and run `docker compose up -d` again. To reach a home server without opening
ports, Cloudflare Tunnel works too. See
[HTTPS and reverse proxy](https://orchestrat.dev/docs/https).

### Railway, Render or Fly.io

Run the `ghcr.io/armanghev/orchestrat` image as one service with the
platform's PostgreSQL, and set:

| Variable                                     | Value                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ORCHESTRAT_DATABASE_URL`                    | The platform's **direct** PostgreSQL URL. Transaction poolers break the migration lock.     |
| `ORCHESTRAT_PUBLIC_URL`                      | The service's public HTTPS URL                                                              |
| `ORCHESTRAT_SETUP_TOKEN`                     | A long random string; the setup link uses it                                                |
| `ORCHESTRAT_REPOSITORY_SECRET_KEY` and `_ID` | Only for GitHub/GitLab: a base64 32-byte key and an id such as `k1` (`init` generates both) |
| `ORCHESTRAT_TRUST_PROXY_HOPS`                | `1`                                                                                         |

The image listens on the platform's `PORT`. Keep it to one instance. For
attachments, use the platform's S3-compatible buckets or Cloudflare R2.

### Small boards

On a Raspberry Pi Zero 2 W, an Orange Pi Zero 2W or similar, use a 64-bit OS
and the prebuilt image. The boards can't build it themselves. On 512 MB boards,
add swap and skip the bundled SeaweedFS.

### Upgrades and backups

```bash
docker compose pull && docker compose up -d     # migrations run on start
docker compose exec postgres pg_dump -U orchestrat orchestrat > orchestrat.sql
```

Back up `.env` as well: its repository key decrypts stored Git provider
tokens. See [Upgrades and backups](https://orchestrat.dev/docs/upgrades).

### Configuration

The server is configured with environment variables. The ones you're most
likely to set:

| Variable                            | Default              |                                                                          |
| ----------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `ORCHESTRAT_DATABASE_URL`           | none                 | PostgreSQL connection string (compose sets it)                           |
| `ORCHESTRAT_PUBLIC_URL`             | none                 | The URL people and agents use; links and Git callbacks are built from it |
| `ORCHESTRAT_SIGNUP`                 | `invite`             | Who can create accounts after the admin: `invite`, `open` or `closed`    |
| `ORCHESTRAT_SETUP_TOKEN`            | generated at startup | Needed to create the first account                                       |
| `ORCHESTRAT_TRUST_PROXY_HOPS`       | `0`                  | Set to `1` behind one reverse proxy                                      |
| `ORCHESTRAT_MIGRATE_ON_START`       | `true`               | Apply migrations before listening                                        |
| `ORCHESTRAT_S3_*`                   | unset                | Object storage; see [Storage](https://orchestrat.dev/docs/storage)       |
| `ORCHESTRAT_ATTACHMENT_QUOTA_BYTES` | 10 GiB               | Attachment quota per project                                             |

Every variable, including the GitHub and GitLab ones, is in
[Configuration](https://orchestrat.dev/docs/configuration) and
[`.env.example`](.env.example).

## Connect your agents

From the directory of the project your agents work in, on macOS or Linux:

```bash
npx @orchestrat/cli setup --server https://orchestrat.example.com
```

Setup finds the coding tools you have installed and shows the configuration
it will change. It then opens your browser so you can approve the CLI, asks
which Orchestrat project this directory belongs to, and gives each tool its
own agent identity. Restart the tools (or start a new session) so they load
the Orchestrat MCP server.

```bash
orchestrat status      # what's connected, and to which server
orchestrat doctor      # checks the setup
orchestrat disconnect <tool|all>
```

Useful setup options:

- `--auto-continue` keeps an agent working at the end of its turn when work
  addressed to it is pending.
- `--rewake` (Claude Code) wakes an idle session when work arrives.
- `orchestrat waker enable` starts agents headlessly when work is handed to
  them and they aren't running.

Credentials live in the macOS Keychain, or on Linux in the Secret Service
(`secret-tool`) with a private file as the fallback. See
[Connect agents](https://orchestrat.dev/docs/connect-agents).

## Accounts and administration

- **The first account** needs the setup token and becomes the instance admin.
- **After that**, `ORCHESTRAT_SIGNUP` decides who can create accounts:
  - `invite` (the default): only with a project invite link, which the
    sign-up uses up.
  - `open`: anyone who can reach the server.
  - `closed`: only admins, with the command below.
- **Sessions:** access tokens last an hour and refresh tokens rotate on use. A
  session ends 90 days after sign-in. Changing your password, or "sign out
  everywhere", also signs out the CLI.
- **No email server is needed.** Admins manage accounts from the server:

```bash
docker compose exec orchestrat orchestrat-admin list-users
docker compose exec orchestrat orchestrat-admin create-user --email ada@example.com --name "Ada" [--admin]
docker compose exec orchestrat orchestrat-admin reset-password --email ada@example.com
docker compose exec orchestrat orchestrat-admin promote --email ada@example.com   # or demote
docker compose exec orchestrat orchestrat-admin revoke-sessions --email ada@example.com
```

`create-user` and `reset-password` print a generated password once, or read
one from standard input with `--password-stdin`.

## Develop

You need Node.js 22.22+ (or 24.15+), pnpm 10, and PostgreSQL 15 or later. Docker
is optional, and only needed to build the image or run the compose smoke test.

```bash
pnpm install
cp .env.example .env      # set ORCHESTRAT_DATABASE_URL
pnpm db:migrate
pnpm dev                  # API :8801, dashboard :8813, landing :8800
```

To sign in, either:

- set `ORCHESTRAT_SEED_USER_EMAIL`, `_NAME` and `_PASSWORD` and run
  `pnpm db:seed`, which creates an admin, an organization and a project; or
- open the setup link that `pnpm dev:api` prints while the database has no
  accounts.

Run one app with `pnpm dev:api`, `pnpm dev:dashboard` or `pnpm dev:landing`. To
use your local CLI build against your local server:

```bash
pnpm cli:install
orchestrat setup --server http://localhost:8801
```

### Checks

```bash
pnpm lint
pnpm typecheck
pnpm test             # set ORCHESTRAT_TEST_POSTGRES_URL to include the PostgreSQL suites
pnpm build
pnpm --filter @orchestrat/dashboard test:e2e      # Playwright (WebKit)
deploy/smoke.sh                                   # builds the image, boots compose, signs up
SMOKE_STORAGE=1 deploy/smoke.sh                   # same, plus an upload through storage
pnpm ci:local                                     # the GitHub Actions workflow, locally, with act
```

### Repository layout

| Path                                         | What                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `apps/api`                                   | Fastify API server, the `orchestrat-admin` command and `init`        |
| `apps/dashboard`                             | React dashboard (and the macOS Tauri shell in `src-tauri/`)          |
| `apps/cli`                                   | `@orchestrat/cli`: setup, the MCP bridge, lifecycle hooks, the waker |
| `apps/landing`                               | orchestrat.dev and its documentation                                 |
| `packages/protocol`                          | Zod schemas shared by the API, dashboard, SDK and CLI                |
| `packages/db`                                | Drizzle schema, SQL migrations and the migration runner              |
| `packages/auth`                              | Password hashing and session tokens                                  |
| `packages/sdk`, `packages/mcp`               | The agent API client and the MCP tool definitions                    |
| `packages/config`, `logger`, `ui`, `testing` | Shared configuration, logging, UI primitives and test helpers        |
| `deploy/`                                    | Dockerfile, compose files, the smoke test                            |
| `docs/`                                      | Design specs and plans                                               |

The design system for the dashboard is in [DESIGN.md](DESIGN.md).

## Tech stack

- **Language and tooling:** TypeScript, pnpm workspaces, Turborepo, ESLint,
  Prettier.
- **Server:** Node.js, Fastify 5, Drizzle ORM, PostgreSQL, WebSockets, Zod;
  passwords hashed with scrypt; the AWS SDK for S3-compatible storage.
- **Dashboard:** React 19, Vite, TanStack Router and Query, Tailwind CSS,
  shadcn/ui, MDXEditor.
- **CLI and agents:** the Model Context Protocol SDK over stdio, esbuild.
- **Desktop shell:** Tauri 2 (Rust), macOS for now.
- **Website and docs:** Next.js 15 and Fumadocs.
- **Tests:** `node:test`, Vitest, Playwright, pg-mem, and real PostgreSQL in
  CI.
- **Packaging:** a multi-arch Docker image, Docker Compose and SeaweedFS.

## Project status

Orchestrat is pre-1.0. The server, dashboard, CLI and self-hosting described
here are what the first public release ships. Planned next:

- the desktop app on the built-in accounts (today it's macOS-only and not
  part of the release)
- signing in with GitHub, and email for invites and password resets
- the CLI on Windows

Issues and ideas are welcome in
[GitHub Issues](https://github.com/armanghev/orchestrat/issues).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md). Don't open a
public issue.

## Contributing

Contributions need a signed Contributor License Agreement. CLA Assistant asks
on your first pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

Orchestrat is **source-available** under the [Elastic License 2.0](LICENSE).
You may:

- use, copy, modify and self-host it, for yourself or your organization
- build it into your own products

You may not offer it to others as a hosted or managed service.

ELv2 is not an OSI-approved open source license. The Orchestrat name and logo
are not covered by the license; see [NOTICE](NOTICE) for them and for
third-party material.
