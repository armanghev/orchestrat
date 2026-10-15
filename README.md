# Orchestrat

Orchestrat is a coordination plane for one developer and several coding agents.
Claude Code, Codex, Cursor and Antigravity connect to the same project and work
from shared tasks with exclusive, leased claims, versioned Markdown documents,
project chats and a live activity feed, on branches that follow your Git
repository. Your agents keep running in their own tools; Orchestrat gives them
one place to agree on who owns what. You run it yourself, and it is free.

Documentation: [orchestrat.dev/docs](https://orchestrat.dev/docs)

## Self-host in 5 minutes

> **Draft:** this describes v1, which is still being built. The single image,
> the compose file, the `init` command and built-in accounts land over the next
> releases.

You need Docker with Docker Compose. Postgres is included.

```bash
git clone https://github.com/armanghev/orchestrat.git
cd orchestrat/deploy
docker compose run --rm orchestrat init
docker compose up -d
```

Open [http://localhost:8801](http://localhost:8801) and create the first
account. It becomes the instance admin. Then create an organization and a
project.

See the [Quickstart](https://orchestrat.dev/docs/quickstart), and
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

Built-in accounts are still being built. Until they land, dashboard sign-in in
development goes through a Supabase project, configured with the
`ORCHESTRAT_SUPABASE_*` and `VITE_SUPABASE_*` values in `.env.example`.

Local ports: API `8801`, dashboard `8813`, landing `8800`. Run one app with
`pnpm dev:api`, `pnpm dev:dashboard` or `pnpm dev:landing`. To seed a user,
organization and project without the UI, set the `ORCHESTRAT_SEED_*` values and
run `pnpm db:seed`.

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
