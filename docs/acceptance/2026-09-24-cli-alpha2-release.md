# CLI alpha.2 release acceptance — 2026-09-24 UTC

Release source: `codex/cli-alpha-2`, based on GitHub main `471cef3`.
Release commits: `68d307c` (version, contract checks, release instructions) and
`f3f38ce` (supported Node runtime floor). The original checkout and its six
unpublished commits were left unchanged. No hosted configuration or deployment
was changed.

## Package verification and publication

- CLI, protocol, SDK, and MCP builds, lint, and typechecks passed.
- Tests: CLI 74, protocol 10, SDK 10, MCP 5; all 99 passed.
- Added regression coverage for `RATE_LIMITED`, document-list folders, and
  rejection of non-Markdown create/rename paths before HTTP. The artifact
  verifier also exercises these contracts from the packed bundle, including
  compatibility with document lists that omit folders.
- The initial candidate failed on Node 20.0.0 because the bundled prompt
  library imports `node:util.styleText`. It was never published. The corrected
  package declares `^20.19.0 || >=22.12.0`, matching the supported runtime floor.
- The corrected tarball and a fresh registry installation both passed the
  artifact verifier on Node 20.19.0 and Node 26.3.1. Its MCP registry exposes
  all 22 expected tools. A mismatched expected-version check failed as intended.
- Tarball inspection found only `dist/main.js` and `package.json`; a bounded
  credential-pattern and developer-path scan passed. No environment files,
  credentials, or private acceptance fixtures were included.
- Published `@orchestrat/cli@0.1.0-alpha.2` under `alpha` at
  `2026-09-24T05:11:23.869Z`, after user-completed npm browser verification.
  `latest` remained on `0.1.0-alpha.1` during hosted acceptance.
- The registry integrity matched the exact verified tarball:
  `sha512-v+EyPV8/aYVLSRl6zvvAyOksPQBmwURkfYw/TZ40MT950vIzD/dRm/jbhlv2Xss2eAjZl5NhMxEFwxdlmvdpDA==`.
  Tarball SHA-256:
  `9e5b626a569fdbc53d078e14c41bca1dd34493b8e50d2609bdf55ed0b92f8ec4`.

## Installed artifact and isolation

- Installed the fresh registry artifact into the managed persistent launcher;
  `orchestrat --version` reports `0.1.0-alpha.2`. Installed bundle SHA-256:
  `26d14bb1d15f9e55fed720c76c623afa22e52ce4d7f56af0c4f891165754c192`.
- Before replacement, the previous runtime, launcher target, and five
  Codex/Claude/Orchestrat configuration files were backed up privately. All
  five config files were unchanged by installation. The installer pruned the
  previous managed runtime; its private backup permits recovery.
- Hosted authentication uses alpha through `https://app.orchestrat.dev` and
  `https://api.orchestrat.dev`. The user approved a fresh browser CLI session.
  The bootstrap kept that CLI credential in memory and provisioned only the
  two project-scoped test agents, stored in origin-scoped Keychain accounts.
  Existing CLI credentials and legacy unbound entries were not read or reused.
- Agent provisioning used the setup API and current authorization helper;
  the coordination harness launched the unmodified registry-installed CLI
  twice. This does not establish interactive installer onboarding on a virgin
  Mac, nor an actual LLM conversation in either harness application.

## Hosted two-agent results

Acceptance project: `c72ed7bb-6497-4c2a-a6f5-ccb3ad0cc29b`
(`Alpha acceptance 2026-09-24`).

- Agents: Codex `3881538b-fdc7-455a-a5cc-9ac9f559d3dc`, Claude Code
  `65df6c76-ac80-4104-adf7-84bd530cc758`.
- Sessions: `767409a5-5e06-47b1-bf9e-38d0ea65815b`,
  `82fb5cee-4719-4f93-b872-da814caef9d7`.
- Task `416e4a8c-4b82-401d-87de-5311242dfc60` and idempotent comment
  `9991e297-c01e-48bc-8184-6dce279f445e` were created successfully.
- Document `902062c9-9cf2-40a0-9eca-e43bfb593383` was shared across transports.
  A stale revision returned `DOCUMENT_CONFLICT` without replacing the winning
  content: request `req_28390b0c-5cb9-4827-9361-75d5f2dfdc90`.
- Exactly one concurrent claim succeeded (Claude Code); the loser received
  `TASK_ALREADY_CLAIMED`: request `req_c83efa5e-fedd-40a2-9614-e501aec5b3de`.
  The winning MCP process was then killed to exercise lease recovery.

- After the winning process stopped, Codex took over the expired lease after
  33 seconds and completed the task.
- Reconnection preserved the completed task, the idempotent comment, and the
  winning document content. Durable event IDs were `61..83`.
- The harness passed all two-agent checks. Both temporary agents and the
  ephemeral CLI authorization were revoked; the test Keychain accounts and
  private working-directory mapping were removed.
- All five configuration files independently matched their pre-upgrade hashes
  after cleanup. The persistent launcher still matched the fresh registry
  bundle byte-for-byte and reported `0.1.0-alpha.2`.

This was a reversible clean-configuration test on the existing Mac, not a
virgin-Mac certification or a server-restart durability test. Test project data
was retained as acceptance evidence.

## Promotion

After hosted acceptance and cleanup passed, user-completed npm browser
verification allowed promotion to `latest`. Independent registry queries for
both `alpha` and `latest` resolved to `0.1.0-alpha.2` with the exact verified
SHA-512 integrity recorded above. No immutable package version was overwritten
or unpublished.
