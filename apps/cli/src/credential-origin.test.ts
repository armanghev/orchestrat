import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryCredentialReader,
  agentAccount,
  cliAccount
} from "./keychain.js";
import { resolveInvocation, resolveGlobalInvocation } from "./resolve.js";
import { resolveSetupAuthorization, runSetup } from "./setup.js";
import { runHook } from "./hooks.js";
import { type OrchestratConfig } from "./config.js";

const api = "https://api.test";
const other = "https://other.test";
const config: OrchestratConfig = {
  version: 1,
  projects: {
    "/workspace": {
      projectId: "p",
      apiUrl: api,
      integrations: { codex: { agentId: "a" } }
    }
  },
  globalProjects: {
    codex: {
      p: {
        name: "Project",
        organizationName: "Org",
        apiUrl: other,
        agentId: "b"
      }
    }
  }
};
const values = new Map([
  ["cli", "unbound-cli"],
  ["agent:p:codex", "unbound-project"],
  ["agent:codex", "unbound-agent"],
  ["codex", "unbound-bare"],
  [cliAccount(api), "first-cli"],
  [agentAccount("p", "codex", api), "first-agent"]
]);

test("local, global and hook credentials cannot cross API origins or use legacy aliases", async () => {
  const credentials = new MemoryCredentialReader(values);
  const input = {
    cwd: "/workspace",
    integration: "codex" as const,
    read: async () => config,
    credentials
  };
  const local = await resolveInvocation({
    ...input,
    api: "https://API.TEST:443/path"
  });
  assert.equal(local.credential, "first-agent");
  assert.equal(local.api, api);
  await assert.rejects(
    resolveInvocation({ ...input, api: other }),
    /run orchestrat setup/
  );
  await assert.rejects(resolveGlobalInvocation(input), /No codex credential/);
  await assert.rejects(
    runHook({
      ...input,
      home: "/unused",
      api: other,
      payload: {
        hook_event_name: "SessionStart",
        session_id: "s",
        cwd: "/workspace"
      },
      fetch: async () => {
        assert.fail("must not send a credential");
      }
    }),
    /run orchestrat setup/
  );
  const both = new MemoryCredentialReader(
    new Map([...values, [agentAccount("p", "codex", other), "second-agent"]])
  );
  const [global] = await resolveGlobalInvocation({
    ...input,
    credentials: both
  });
  assert.equal(global!.credential, "second-agent");
  assert.equal(global!.apiUrl, other);
});

test("global resolution skips a stale project instead of failing the connection", async () => {
  const twoProjects: OrchestratConfig = {
    ...config,
    globalProjects: {
      codex: {
        ...config.globalProjects!.codex,
        stale: {
          name: "Old acceptance",
          organizationName: "Org",
          apiUrl: other,
          agentId: "c"
        }
      }
    }
  };
  const warnings: string[] = [];
  const projects = await resolveGlobalInvocation({
    integration: "codex",
    read: async () => twoProjects,
    credentials: new MemoryCredentialReader(
      new Map([[agentAccount("p", "codex", other), "live-agent"]])
    ),
    warn: (message) => warnings.push(message)
  });
  assert.deepEqual(
    projects.map((project) => project.projectId),
    ["p"]
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /skipping Org \/ Old acceptance/);
  assert.doesNotMatch(warnings[0]!, /live-agent/);
});

test("CLI setup reauthorizes unknown origins and records the actual normalized issuer", async () => {
  const stored = new Map(values);
  const store = {
    read: async (key: string) => stored.get(key),
    write: async (key: string, value: string) => {
      stored.set(key, value);
    },
    remove: async (key: string) => {
      stored.delete(key);
    }
  };
  let opens = 0;
  const transport = {
    api: other + "/ignored",
    open: async () => {
      opens++;
    },
    sleep: async () => {},
    fetch: (async (input, init) => {
      const url = String(input);
      assert.ok(url.startsWith(other + "/api/v1/"));
      assert.doesNotMatch(JSON.stringify(init), /first-cli|unbound/);
      if (url.endsWith("/attempts"))
        return Response.json({
          attempt_id: "attempt",
          secret: "poll-secret",
          expires_at: new Date(Date.now() + 60_000).toISOString()
        });
      if (url.endsWith("/poll"))
        return Response.json({ status: "approved", credential: "second-cli" });
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer second-cli"
      );
      return Response.json({ projects: [] });
    }) as typeof fetch
  };
  const authorized = await resolveSetupAuthorization(transport, store);
  assert.equal(authorized.api, other);
  assert.equal(opens, 1);
  assert.equal(stored.get(cliAccount(api)), "first-cli");
  assert.equal(stored.get(cliAccount(other)), "second-cli");
  await resolveSetupAuthorization(
    { ...transport, api: "https://OTHER.test:443" },
    store
  );
  assert.equal(opens, 1);
  await assert.rejects(
    runSetup({
      ...transport,
      store,
      authorization: { api, credential: "first-cli", projects: [] },
      home: "/unused",
      cwd: "/unused",
      integrations: [],
      sourceCommand: "/unused"
    }),
    /different API/
  );
});
