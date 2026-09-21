# Live MCP acceptance — 2026-09-21

Result: **PASS** at `2026-09-21T08:25:46Z`.

This run used the installed `/Users/armanghevondyan/.local/bin/orchestrat`
release artifact (`0.1.0-alpha.1`) twice: Codex and Claude Code MCP transports, both mapped to
the disposable project `8b236506-669d-46a3-a0c7-fe93a724321b` from
`/private/tmp/orchestrat-clean-config.cfUFCn`. It used hosted Orchestrat-dev
authentication with the local API/Postgres service at `http://localhost:8801`.
It is not a virgin-Mac test, a hosted-API test, or a fully hosted acceptance.
This validates the installed release artifact, not the current source checkout
or an unpublished rebuilt CLI.

## Evidence

- Two distinct live sessions and agent identities were opened and heartbeated:
  sessions `1374797f-db6f-4379-97fc-e850f487c209`,
  `c7cd4602-ace7-4e20-8d31-153cb1269027`; agents
  `c0249d0a-1964-466b-a49a-3c48c99afb2e`,
  `7ec729a3-55c5-4564-8822-f5a574e11771`.
- Created task `75beca40-656b-4a93-8bb1-8403010c2242` in `ready` state.
- Created idempotent comment `578d20e0-415d-4e85-b39c-24ca91082c10`; retry
  returned the same comment and its author was the Codex agent identity.
- Created document `1910fc58-700a-4ff5-b870-87c04d7535fb`, read it from the
  second transport, updated it, and verified stale revision `1` returned
  `DOCUMENT_CONFLICT` without overwriting the winner content.
- Concurrent claim race produced exactly one winner (Codex) and one
  `TASK_ALREADY_CLAIMED` loser (`409` semantics).
- The winner MCP child was killed. After the 30-second lease expired in
  five-second polling chunks, the loser took over and completed the task.
- A fresh MCP transport reconnected and verified the durable completed task,
  comment, winning document content, and 21 recent project events.
- A subsequent read-only MCP check verified the current durable event range
  `1097..1119` (`23` events returned).
- The reusable harness records each API conflict `request_id` without printing
  response bodies or credentials; the original run predates that logging and
  did not retain those two IDs.

## Reproduction

```sh
ORCHESTRAT_CLI=/Users/armanghevondyan/.local/bin/orchestrat \
ORCHESTRAT_ACCEPTANCE_CWD=/private/tmp/orchestrat-clean-config.cfUFCn \
ORCHESTRAT_ACCEPTANCE_PROJECT_ID=8b236506-669d-46a3-a0c7-fe93a724321b \
ORCHESTRAT_API_URL=http://localhost:8801 \
  node scripts/acceptance/mcp-live-acceptance.mjs
```

The harness validates the project UUID before mutations, inherits the real
`HOME`/`CODEX_HOME` for the existing disposable Keychain mapping, never prints
credentials or claim tokens, and terminates only its own MCP children.
