# Contributing to Orchestrat

Thanks for helping. This guide covers the development setup, the checks a pull
request has to pass, the repo's conventions and the Contributor License
Agreement.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues
privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Development setup

The repo is a pnpm and Turborepo monorepo:

- `apps/api`: Fastify API server
- `apps/dashboard`: Vite and React dashboard (plus the Tauri desktop shell)
- `apps/cli`: the `orchestrat` CLI, MCP bridge and agent hooks
- `apps/landing`: the orchestrat.dev website
- `packages/*`: shared protocol, database, MCP, SDK, auth, config, logger and
  UI packages

You need:

- Node.js at the version in [`.nvmrc`](.nvmrc) (`nvm use`). `package.json`
  `engines` lists the supported ranges.
- pnpm 10. Running `corepack enable` picks up the exact version pinned in
  `packageManager`.
- A PostgreSQL database for the API.

Install, configure and start everything:

```bash
pnpm install
cp .env.example .env   # set ORCHESTRAT_DATABASE_URL
pnpm db:migrate
pnpm dev
```

`.env.example` lists every variable the apps read. Until built-in accounts
land, dashboard sign-in in development goes through a Supabase project,
configured with the `ORCHESTRAT_SUPABASE_*` and `VITE_SUPABASE_*` values.

`pnpm dev` starts every app through Turborepo. Local ports are API `8801`,
dashboard `8813` and landing `8800`. To run one app, use `pnpm dev:api`,
`pnpm dev:dashboard` or `pnpm dev:landing`. To seed a user, organization and
project without the UI, set the `ORCHESTRAT_SEED_*` values and run
`pnpm db:seed`.

To try a local build of the CLI, run `pnpm cli:install`.

## Checks

These are the checks CI runs on every pull request:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` builds first, because most backend tests run from `dist`. The
Postgres integration tests are opt-in: set `ORCHESTRAT_TEST_POSTGRES_URL` to a
role that may create databases. Each run creates and drops its own database.

Dashboard browser tests use Playwright with WebKit:

```bash
pnpm --filter @orchestrat/dashboard exec playwright install webkit
pnpm --filter @orchestrat/dashboard test:e2e
```

### Run CI locally with act

Before you push or open a pull request, run the GitHub Actions workflow locally
in Docker with [act](https://github.com/nektos/act) (`brew install act`). The
runner image and artifact path are set in [`.actrc`](.actrc).

```bash
pnpm ci:local                # both jobs, as on a pull request
act pull_request -j verify   # lint, typecheck, tests with Postgres, build
act pull_request -j browser  # Playwright in Linux WebKit
```

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, for example `feat(dashboard): ...`,
  `fix(api): ...`, `docs: ...`, `test(cli): ...` or `chore: ...`. The scope
  is the app or package you changed.
- **Formatting** is Prettier. Run `pnpm format` (or Prettier on the files you
  changed) before committing.
- **UI** changes follow [`DESIGN.md`](DESIGN.md), the dashboard design system.
- **Acceptance docs and other evidence** must not contain infrastructure IDs
  (project, service, deployment or database IDs), secrets, tokens, or paths
  from your home directory. Use repo-relative paths and placeholders.
- Keep pull requests focused, and update the docs that describe the behavior
  you changed.

## Contributor License Agreement

Every contributor signs the [Contributor License Agreement](CLA.md) once,
before their first pull request can be merged. When you open that pull
request, the CLA Assistant bot comments with a link; sign there with your
GitHub account. The signature covers your later contributions too.

The CLA lets the project owner distribute and relicense your contribution as
part of Orchestrat, while you keep the copyright and the right to use your own
work however you like.

## License

Orchestrat is source-available under the [Elastic License 2.0](LICENSE). See
[NOTICE](NOTICE) for trademarks and third-party material.
