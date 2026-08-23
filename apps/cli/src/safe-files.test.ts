import assert from "node:assert/strict";
import test from "node:test";
import { mergeHooks, mergeJson, mergeToml } from "./safe-files.js";

test("managed adapters emit exact nested hooks and preserve unrelated entries", () => {
  const command = "/Applications/My CLI/orchestrat";
  const codex = JSON.parse(
    mergeHooks(
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "other",
              hooks: [{ type: "command", command: "echo keep" }]
            }
          ]
        }
      }),
      "codex",
      command
    )
  );
  assert.deepEqual(codex.hooks.SessionStart[0], {
    matcher: "other",
    hooks: [{ type: "command", command: "echo keep" }]
  });
  assert.deepEqual(codex.hooks.SessionStart[1], {
    matcher: "startup|resume",
    hooks: [
      {
        type: "command",
        command: "'/Applications/My CLI/orchestrat' hook codex"
      }
    ]
  });
  assert.deepEqual(
    JSON.parse(mergeHooks(JSON.stringify(codex), "codex", command)),
    codex
  );
  const claude = JSON.parse(
    mergeHooks(
      '{"mcpServers":{"other":{"command":"keep"}}}',
      "claude-code",
      command
    )
  );
  assert.equal(claude.mcpServers.other.command, "keep");
  assert.equal(
    JSON.parse(mergeJson(JSON.stringify(claude), "claude-code", command))
      .mcpServers.orchestrat.command,
    command
  );
});

test("managed adapter rejects scoped conflicts", () => {
  assert.throws(() =>
    mergeToml(
      '[mcp_servers.other]\ncommand = "bad"\n\n[mcp_servers.orchestrat]\ncommand = "/bin/orchestrat"\nargs = ["bad"]\n',
      "codex",
      "/bin/orchestrat"
    )
  );
  assert.throws(() =>
    mergeHooks(
      '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/bin/orchestrat hook codex --bad"}]}]}}',
      "codex",
      "/bin/orchestrat"
    )
  );
});

test("managed hook regressions stay scoped and idempotent", () => {
  const command = "/tmp/a b$c`d'e/orchestrat";
  const safe = `'/tmp/a b$c\`d'\\''e/orchestrat' hook codex`;
  const input = JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            { type: "command", command: safe },
            { type: "command", command: "echo sibling" }
          ]
        },
        { hooks: [{ type: "command", command: "/bin/foo hook codex" }] }
      ]
    }
  });
  const merged = JSON.parse(mergeHooks(input, "codex", command));
  assert.equal(
    merged.hooks.SessionStart.filter((group: any) =>
      group.hooks.some((h: any) => h.command === safe)
    ).length,
    1
  );
  assert.equal(
    merged.hooks.SessionStart[1].hooks[0].command,
    "/bin/foo hook codex"
  );
  const wrongMatcher = JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "wrong",
          hooks: [{ type: "command", command: "/tmp/orchestrat hook codex" }]
        }
      ]
    }
  });
  assert.throws(() => mergeHooks(wrongMatcher, "codex", command));
  const extraArgs = JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            { type: "command", command: "/tmp/orchestrat hook codex --extra" }
          ]
        }
      ]
    }
  });
  assert.throws(() => mergeHooks(extraArgs, "codex", command));
  const toml = `model = "keep"\n  [mcp_servers.orchestrat]  \ncommand = "${command}"\nargs = ["mcp", "--integration", "codex"]\n`;
  assert.equal(mergeToml(toml, "codex", command), toml);
});
