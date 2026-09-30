import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AgentApiClient } from "@orchestrat/sdk";
import { utimes } from "node:fs/promises";
import { nodeGitReader, type GitReader } from "./git.js";
import {
  branchOverridesPath,
  checkoutResolver,
  checkoutTarget,
  registerTarget,
  runBranchCommand,
  setBranchOverride
} from "./branches.js";
import { runHook } from "./hooks.js";
import { deterministicSessionId } from "./hook-types.js";
import { parseInvocationArgs } from "./main.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const branchId = "00000000-0000-4000-8000-0000000000b1";
const defaultId = "00000000-0000-4000-8000-0000000000b0";
const sha = "0123456789abcdef0123456789abcdef01234567";
const timestamp = "2026-09-30T00:00:00.000Z";
const branch = (id: string, name: string, extra: object = {}) => ({
  id,
  project_id: projectId,
  name,
  is_default: id === defaultId,
  name_source: "cli",
  created_via: "cli",
  created_by: null,
  onboarding_state: "completed",
  onboarding_choice: null,
  archived_at: null,
  archived_reason: null,
  provider: null,
  open_decision_count: 0,
  created_at: timestamp,
  updated_at: timestamp,
  ...extra
});

async function repo(head = "ref: refs/heads/feat/login\n") {
  // Real paths: config mappings are keyed by the canonical checkout path.
  const home = await realpath(
    await mkdtemp(join("/tmp", "orchestrat-branches-"))
  );
  const root = join(home, "repo");
  await mkdir(join(root, ".git/refs/heads/feat"), { recursive: true });
  await mkdir(join(root, ".git/refs/remotes/origin"), { recursive: true });
  await writeFile(join(root, ".git/HEAD"), head);
  await writeFile(join(root, ".git/refs/heads/feat/login"), `${sha}\n`);
  await writeFile(
    join(root, ".git/refs/remotes/origin/HEAD"),
    "ref: refs/remotes/origin/main\n"
  );
  return { home, root };
}

type Call = { url: string; method: string; headers: Headers; body?: any };

function api(
  respond: (call: Call) => { status?: number; body: unknown } | undefined
) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    };
    calls.push(call);
    const result = respond(call) ?? {
      status: 404,
      body: {
        error: {
          code: "NOT_FOUND",
          message: "Not found.",
          details: {},
          request_id: "req_test"
        }
      }
    };
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200
    });
  };
  const client = new AgentApiClient({
    baseUrl: "https://api.test",
    token: "orch_agent_token",
    fetch
  });
  return { calls, client, fetch };
}

test("overrides pick the branch per checkout until --follow", async (t) => {
  const { home, root } = await repo();
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(
    { ...(await checkoutTarget(join(root), home)), checkout: undefined },
    { checkout: undefined, name: "feat/login", overridden: false }
  );
  await setBranchOverride(home, root, "release/1.0");
  const overridden = await checkoutTarget(root, home);
  assert.equal(overridden.name, "release/1.0");
  assert.equal(overridden.overridden, true);
  const stored = JSON.parse(await readFile(branchOverridesPath(home), "utf8"));
  assert.equal(stored.version, 1);
  await setBranchOverride(home, root, null);
  assert.equal((await checkoutTarget(root, home)).name, "feat/login");
});

test("registration sends Git details and never throws", async (t) => {
  const { home, root } = await repo();
  t.after(() => rm(home, { recursive: true, force: true }));
  const ok = api((call) =>
    call.url.endsWith("/branches/register")
      ? { body: { branch: branch(branchId, call.body.name), created: true } }
      : undefined
  );
  const target = await checkoutTarget(root, home);
  assert.equal((await registerTarget(ok.client, target)).branch?.id, branchId);
  assert.deepEqual(ok.calls[0]!.body, {
    name: "feat/login",
    git_default_branch: "main",
    head_sha: sha
  });
  await registerTarget(ok.client, { ...target, overridden: true });
  assert.equal(
    ok.calls[1]!.body.head_sha,
    undefined,
    "HEAD is not the override"
  );

  const archived = api(() => ({
    status: 409,
    body: {
      error: {
        code: "BRANCH_ARCHIVED",
        message: "This branch is archived.",
        details: { branch_id: branchId },
        request_id: "req_test"
      }
    }
  }));
  const refused = await registerTarget(archived.client, target);
  assert.equal(refused.branch, null);
  assert.equal((refused.error as { code?: string }).code, "BRANCH_ARCHIVED");

  const odd = await registerTarget(ok.client, {
    ...target,
    checkout: { ...target.checkout!, defaultBranch: "bad name" }
  });
  assert.equal(odd.branch?.id, branchId, "a strange default name is dropped");
  assert.deepEqual(ok.calls.at(-1)!.body, { name: "feat/login" });
  assert.deepEqual(
    await registerTarget(ok.client, { ...target, name: null }),
    { branch: null },
    "a detached HEAD works on the default branch"
  );
});

test("branch commands list, create, select and report", async (t) => {
  const { home, root } = await repo();
  t.after(() => rm(home, { recursive: true, force: true }));
  const { calls, client } = api((call) => {
    if (call.url.endsWith("/branches/register"))
      return {
        body: { branch: branch(branchId, call.body.name), created: true }
      };
    if (call.url.includes("/branches?name=missing"))
      return { body: { branches: [] } };
    if (call.url.includes("/branches"))
      return {
        body: {
          branches: [branch(defaultId, "main"), branch(branchId, "feat/login")]
        }
      };
    return undefined;
  });
  const run = (input: Partial<Parameters<typeof runBranchCommand>[0]>) =>
    runBranchCommand({
      action: "current",
      client,
      cwd: root,
      home,
      ...input
    } as Parameters<typeof runBranchCommand>[0]);

  const current = (await run({})) as {
    checkout: { branch: string; default_branch: string };
    branch: { id: string };
    default_branch: { id: string };
    override: string | null;
  };
  assert.equal(current.checkout.branch, "feat/login");
  assert.equal(current.checkout.default_branch, "main");
  assert.equal(current.branch.id, branchId);
  assert.equal(current.default_branch.id, defaultId);
  assert.equal(current.override, null);

  await run({ action: "list", includeArchived: true });
  assert.equal(
    calls.at(-1)!.url,
    "https://api.test/api/v1/agent/branches?include_archived=true"
  );
  await run({ action: "create", name: "feat/new" });
  assert.deepEqual(calls.at(-1)!.body, { name: "feat/new", force_new: true });

  const selected = (await run({ action: "select", name: "feat/login" })) as {
    follow_checkout: boolean;
  };
  assert.equal(selected.follow_checkout, false);
  assert.equal((await checkoutTarget(root, home)).overridden, true);
  await assert.rejects(
    run({ action: "select", name: "missing" }),
    /No active branch named missing/
  );
  await run({ action: "select", follow: true });
  assert.equal((await checkoutTarget(root, home)).overridden, false);
  await assert.rejects(
    run({ action: "select", follow: true, cwd: home }),
    /Not inside a Git checkout/
  );
});

test("hooks pin the checkout branch into the header and the session id", async (t) => {
  const { home, root } = await repo();
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = {
    version: 1 as const,
    projects: {
      [root]: {
        projectId,
        integrations: { "claude-code": { agentId } }
      }
    }
  };
  const lifecycle = (sessionId: string) => ({
    event_id: 1,
    session: {
      id: sessionId,
      agent_id: agentId,
      project_id: projectId,
      runtime: "claude",
      integration: "claude-code",
      external_session_id: "conversation-1",
      status: "active",
      started_at: timestamp,
      ended_at: null,
      last_heartbeat_at: timestamp
    }
  });
  const run = (fetch: typeof globalThis.fetch) =>
    runHook({
      integration: "claude-code",
      cwd: home,
      home,
      read: async () => config,
      credentials: { read: async () => "orch_agent_token" },
      api: "https://api.test",
      fetch,
      payload: {
        hook_event_name: "SessionStart",
        session_id: "conversation-1",
        cwd: join(root)
      }
    });

  const current = api((call) =>
    call.url.endsWith("/branches/register")
      ? { body: { branch: branch(branchId, "feat/login"), created: false } }
      : { body: lifecycle(call.body.session_id) }
  );
  await run(current.fetch);
  const [register, hook] = current.calls;
  assert.equal(
    register!.url,
    "https://api.test/api/v1/agent/branches/register"
  );
  assert.equal(hook!.headers.get("x-orchestrat-branch-id"), branchId);
  assert.equal(
    hook!.body.session_id,
    deterministicSessionId("claude-code", "conversation-1", branchId)
  );

  // An API from before branches: the hook behaves exactly as it used to.
  const old = api((call) =>
    call.url.endsWith("/hooks/lifecycle")
      ? { body: lifecycle(call.body.session_id) }
      : undefined
  );
  await run(old.fetch);
  const legacy = old.calls.at(-1)!;
  assert.equal(legacy.headers.get("x-orchestrat-branch-id"), null);
  assert.equal(
    legacy.body.session_id,
    deterministicSessionId("claude-code", "conversation-1")
  );
});

test("branch arguments are strict", () => {
  assert.deepEqual(parseInvocationArgs(["branch", "--integration", "codex"]), {
    command: "branch",
    integration: "codex",
    branchAction: "current"
  });
  assert.deepEqual(
    parseInvocationArgs([
      "branch",
      "list",
      "--include-archived",
      "--integration",
      "codex"
    ]),
    {
      command: "branch",
      integration: "codex",
      branchAction: "list",
      includeArchived: true
    }
  );
  assert.deepEqual(
    parseInvocationArgs([
      "branch",
      "select",
      "feat/login",
      "--integration",
      "codex"
    ]),
    {
      command: "branch",
      integration: "codex",
      branchAction: "select",
      branchName: "feat/login"
    }
  );
  assert.deepEqual(
    parseInvocationArgs([
      "branch",
      "select",
      "--follow",
      "--integration",
      "codex"
    ]),
    {
      command: "branch",
      integration: "codex",
      branchAction: "select",
      follow: true
    }
  );
  for (const argv of [
    ["branch", "list"],
    ["branch", "create", "--integration", "codex"],
    ["branch", "delete", "x", "--integration", "codex"],
    ["branch", "merge", "x", "--integration", "codex"],
    ["branch", "select", "x", "--follow", "--integration", "codex"],
    ["branch", "create", "x", "--include-archived", "--integration", "codex"],
    ["status", "--follow"]
  ])
    assert.throws(() => parseInvocationArgs(argv), argv.join(" "));
});

test("the MCP resolver re-reads the checkout only when HEAD changes", async (t) => {
  const { home, root } = await repo();
  t.after(() => rm(home, { recursive: true, force: true }));
  let reads = 0;
  const counting: GitReader = {
    readFile: (path) => {
      reads++;
      return nodeGitReader.readFile(path);
    },
    kind: nodeGitReader.kind
  };
  const resolve = checkoutResolver(root, home, counting);
  assert.deepEqual(await resolve(), {
    name: "feat/login",
    defaultBranch: "main",
    headSha: sha
  });
  const afterFirst = reads;
  await resolve();
  assert.equal(reads, afterFirst, "an unchanged HEAD is served from cache");

  await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
  const later = new Date(Date.now() + 5_000);
  await utimes(join(root, ".git/HEAD"), later, later);
  assert.equal((await resolve())?.name, "main");

  await setBranchOverride(home, root, "release/1.0");
  const overridden = await resolve();
  assert.equal(overridden?.name, "release/1.0");
  assert.equal(
    overridden?.headSha,
    null,
    "HEAD's commit is not the override's"
  );
  assert.equal(await checkoutResolver(home, home)(), null, "no checkout");
});
