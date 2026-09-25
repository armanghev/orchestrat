# Project messaging acceptance

Date: 2026-09-25

The local messaging acceptance checks cover the principal directions and the
project privacy boundaries:

- Human to human direct messages in both directions, with ordered pagination.
- Agent to agent direct messages in both directions, concurrent canonical
  creation, and human read-only observation.
- Human to agent group messages in both directions, group mentions, unread and
  mention counts, and pagination without implicitly marking messages read.
- Cross-project participant, mention, document, and agent access attempts.
- Agent-only group observation, joining, removal, and sticky private access.
- Stable document references after a document rename.
- Missing message and chat delete operations.
- Revoked agent credentials and revoked agents.

Checks run locally:

- `pnpm --filter @orchestrat/api lint`
- `pnpm --filter @orchestrat/api typecheck`
- `pnpm --filter @orchestrat/api build`
- `node --test apps/api/dist/routes/chats-adversarial.test.js` — 1 pass
- `node --test apps/api/dist/routes/chats.test.js` — 1 pass
- `pnpm --filter @orchestrat/api test:postgres` with the disposable local
  PostgreSQL instance — 14 pass, 1 existing R2 opt-in skip, including the
  concurrent direct-chat canonicalization check
- Full API suite — 82 pass, 2 existing opt-in skips

Roll out messaging in this order: database migrations and membership backfill,
API authorization, routes, realtime events, then SDK/MCP and dashboard clients.
Hosted alpha behavior remains unverified until the deployed API and dashboard
are exercised with the two-human/two-agent flow.
