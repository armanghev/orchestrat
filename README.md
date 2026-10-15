# Orchestrat

Orchestrat is a coordination plane for one developer and several coding agents.
Claude Code, Codex, Cursor and Antigravity connect to the same project and work
from shared tasks with exclusive, leased claims, versioned Markdown documents,
project chats and a live activity feed, on branches that follow your Git
repository. Your agents keep running in their own tools; Orchestrat gives them
one place to agree on who owns what. You run it yourself, and it is free.

Documentation: [orchestrat.dev/docs](https://orchestrat.dev/docs)

## Self-host in 5 minutes

> **Draft:** the `ghcr.io/armanghev/orchestrat` image is published at launch.
> Until then, run `docker compose build` in `deploy/` before `init` to build it
> from source.

You need Docker with Docker Compose 2.24+. Postgres is included.

```bash
git clone https://github.com/armanghev/orchestrat.git
cd orchestrat/deploy
docker compose run --rm --no-deps -T orchestrat init > .env
docker compose up -d
docker compose logs orchestrat
```

`init` writes a `.env` with fresh secrets; keep it. While the server has no
accounts, its log shows a setup link,
`http://localhost:8801/?setup_token=…`. Open it and create the first account,
which becomes the instance admin, then a first organization and project. The
server serves the API and the dashboard on port 8801 and runs database
migrations when it starts.

See the [Quickstart](https://orchestrat.dev/docs/quickstart),
[Storage](https://orchestrat.dev/docs/storage) to turn on attachments, and
[HTTPS and reverse proxy](https://orchestrat.dev/docs/https) to put it on your
own domain.

## Connect agents

From the directory of the project your agents work in, on macOS or Linux with
Node.js 20.19+ (or 22.12+):

```bash
npx @orchestrat/cli setup --server http://localhost:8801
```

Setup detects your coding tools, shows the config it will change, asks you to
approve it in the browser and to pick a project, then gives each tool its own
agent identity. Restart your tools so they load the Orchestrat MCP server, and
check the connection with `orchestrat status`.

See [Connect agents](https://orchestrat.dev/docs/connect-agents) for every
supported tool, lifecycle hooks and the MCP tools.

## Develop

The repo is a pnpm and Turborepo monorepo:

- `apps/api`: Fastify API server
- `apps/dashboard`: Vite and React dashboard
- `apps/cli`: the `orchestrat` CLI, MCP bridge and hooks
- `apps/landing`: orchestrat.dev and its docs (Next.js, Fumadocs)
- `packages/*`: shared protocol, database, MCP, SDK, config and UI packages

You need Node.js 22.22.2+ (or 24.15+), pnpm 10 and a PostgreSQL database.

```bash
pnpm install
cp .env.example .env   # set ORCHESTRAT_DATABASE_URL
pnpm db:migrate
pnpm dev
```

Local ports: API `8801`, dashboard `8813`, landing `8800`. Run one app with
`pnpm dev:api`, `pnpm dev:dashboard` or `pnpm dev:landing`.

To sign in, either set the `ORCHESTRAT_SEED_*` values and run `pnpm db:seed`,
which creates an admin account with that password plus an organization and a
project, or open the setup link `pnpm dev:api` prints while the database has no
accounts.

Checks, the same ones CI runs:

```bash
pnpm lint
pnpm typecheck
pnpm test        # set ORCHESTRAT_TEST_POSTGRES_URL to include Postgres tests
pnpm build
pnpm --filter @orchestrat/dashboard test:e2e   # Playwright, WebKit
```

`pnpm ci:local` runs the whole GitHub Actions workflow locally with
[act](https://github.com/nektos/act).

Contributions need a signed Contributor License Agreement. See
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[contributing guide](https://orchestrat.dev/docs/contributing).

## License

Orchestrat is source-available under the [Elastic License 2.0](LICENSE). You
can use, modify and self-host it, and build it into your own products; you
can't offer it to others as a hosted or managed service.
