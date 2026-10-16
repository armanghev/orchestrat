import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  configPath,
  MISSING_SERVER_MESSAGE,
  parseConfig,
  resolveServerUrl,
  SUGGESTED_SERVER_URL
} from "./config.js";
import { runDoctor, runStatus } from "./diagnostics.js";
import { cliAccount, MemoryCredentialReader } from "./keychain.js";
import type { CredentialStore } from "./keychain.js";
import { parseInvocationArgs } from "./main.js";
import { resolveGlobalInvocation, resolveInvocation } from "./resolve.js";
import { resolveSetupAuthorization } from "./setup.js";
import { promptServerUrl, renderStatus, type UiComponents } from "./ui.js";

const quiet: UiComponents = {
  multiselect: async () => [],
  cancel: () => undefined,
  outro: () => undefined,
  intro: () => undefined,
  log: {
    info: () => undefined,
    success: () => undefined,
    warn: () => undefined
  },
  note: () => undefined,
  spinner: () => ({ start: () => undefined, stop: () => undefined })
};

test("the server comes from --server, then ORCHESTRAT_API_URL, then the project mapping", () => {
  const all = {
    flag: "https://flag.example/ignored",
    env: "https://env.example",
    projectApiUrl: "http://localhost:8801"
  };
  assert.equal(resolveServerUrl(all), "https://flag.example");
  assert.equal(
    resolveServerUrl({ ...all, flag: undefined }),
    "https://env.example"
  );
  // An empty variable is unset, as shells commonly export it.
  for (const env of [undefined, "", "  "])
    assert.equal(
      resolveServerUrl({ ...all, flag: undefined, env }),
      "http://localhost:8801"
    );
  // Nothing is implied: no flag, variable or mapping means no server.
  assert.equal(resolveServerUrl({}), undefined);
  assert.equal(resolveServerUrl({ env: "" }), undefined);
  assert.throws(() => resolveServerUrl({ ...all, flag: "" }), /--server/);
  assert.throws(
    () => resolveServerUrl({ ...all, flag: "ftp://flag.example" }),
    /Invalid --server URL/
  );
  assert.throws(
    () => resolveServerUrl({ env: "not a url" }),
    /Invalid ORCHESTRAT_API_URL/
  );
});

test("setup takes --server and no other command does", () => {
  assert.deepEqual(
    parseInvocationArgs(["setup", "--server", "http://localhost:8801"]),
    { command: "setup", server: "http://localhost:8801" }
  );
  assert.deepEqual(
    parseInvocationArgs([
      "setup",
      "--server=https://orchestrat.example.com",
      "--auto-continue"
    ]),
    {
      command: "setup",
      server: "https://orchestrat.example.com",
      autoContinue: true
    }
  );
  assert.deepEqual(parseInvocationArgs(["setup"]), { command: "setup" });
  for (const command of ["status", "doctor"])
    assert.throws(
      () => parseInvocationArgs([command, "--server", "http://localhost:8801"]),
      /Usage: orchestrat setup \[--server <url>\]/
    );
});

test("non-interactive setup without a server fails before touching anything", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-no-server-"));
  const cwd = join(home, "project");
  await mkdir(cwd);
  const main = fileURLToPath(new URL("./main.js", import.meta.url));
  const failure = await new Promise<{ code: number | null; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [main, "setup"],
        {
          cwd,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            ORCHESTRAT_API_URL: ""
          }
        },
        (error, _stdout, stderr) =>
          resolve({
            code: (error as { code?: number } | null)?.code ?? 0,
            stderr
          })
      );
    }
  );
  assert.equal(failure.code, 1);
  assert.equal(failure.stderr, `orchestrat: ${MISSING_SERVER_MESSAGE}\n`);
  assert.match(failure.stderr, /--server <url>/);
  assert.match(failure.stderr, /ORCHESTRAT_API_URL/);
  assert.doesNotMatch(failure.stderr, /orchestrat\.dev/);
  // Nothing was installed or written in the empty home.
  assert.deepEqual(await readdir(home), ["project"]);
});

test("the interactive prompt suggests the local server and validates input", async () => {
  let seen:
    | {
        placeholder?: string;
        defaultValue?: string;
        validate?: (value: string | undefined) => string | undefined;
      }
    | undefined;
  const answering = (answer: string | symbol): UiComponents => ({
    ...quiet,
    text: async (options) => {
      seen = options;
      return answer;
    }
  });
  assert.deepEqual(await promptServerUrl({ components: answering("") }), {
    cancelled: false,
    value: SUGGESTED_SERVER_URL
  });
  assert.equal(seen?.placeholder, "http://localhost:8801");
  assert.equal(seen?.defaultValue, "http://localhost:8801");
  assert.equal(seen?.validate?.(""), undefined);
  assert.equal(seen?.validate?.("https://orchestrat.example.com"), undefined);
  assert.match(seen?.validate?.("ftp://example.com") ?? "", /http\(s\) URL/);
  assert.deepEqual(
    await promptServerUrl({
      components: answering(" https://orchestrat.example.com/dashboard ")
    }),
    { cancelled: false, value: "https://orchestrat.example.com" }
  );
  assert.deepEqual(
    await promptServerUrl({
      components: answering(Symbol("cancel")),
      isCancel: (answer) => typeof answer === "symbol"
    }),
    { cancelled: true }
  );
});

test("a mapping without a server asks for setup instead of guessing one", async () => {
  const config = parseConfig({
    version: 1,
    projects: {
      "/tmp/project": {
        projectId: "p",
        integrations: { codex: { agentId: "a" } }
      }
    },
    globalProjects: {
      codex: {
        p1: { name: "One", organizationName: "Org", agentId: "a1" },
        p2: {
          name: "Two",
          organizationName: "Org",
          apiUrl: "http://localhost:8801",
          agentId: "a2"
        }
      }
    }
  });
  const credentials = new MemoryCredentialReader(
    new Map([
      ["agent:p:codex:http://localhost:8801", "secret"],
      ["agent:p2:codex:http://localhost:8801", "secret"]
    ])
  );
  await assert.rejects(
    resolveInvocation({
      cwd: "/tmp/project",
      integration: "codex",
      read: async () => config,
      credentials
    }),
    /No Orchestrat server URL for \/tmp\/project; run orchestrat setup --server <url>/
  );
  // The environment still overrides a mapping without apiUrl.
  const resolved = await resolveInvocation({
    api: "http://localhost:8801",
    cwd: "/tmp/project",
    integration: "codex",
    read: async () => config,
    credentials
  });
  assert.equal(resolved.api, "http://localhost:8801");
  const warnings: string[] = [];
  const global = await resolveGlobalInvocation({
    integration: "codex",
    read: async () => config,
    credentials,
    warn: (message) => warnings.push(message)
  });
  assert.deepEqual(
    global.map((project) => [project.projectId, project.apiUrl]),
    [["p2", "http://localhost:8801"]]
  );
  assert.match(warnings.join(""), /skipping Org \/ One: no server URL/);
});

test("browser approval opens on the server's origin unless ORCHESTRAT_WEB_URL overrides it", async (t) => {
  const previous = process.env.ORCHESTRAT_WEB_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.ORCHESTRAT_WEB_URL;
    else process.env.ORCHESTRAT_WEB_URL = previous;
  });
  const approve = async (api: string) => {
    const values = new Map<string, string>();
    const store: CredentialStore = {
      read: async (account) => values.get(account),
      write: async (account, value) => {
        values.set(account, value);
      },
      remove: async (account) => {
        values.delete(account);
      }
    };
    const opened: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      const body = url.endsWith("/attempts")
        ? {
            attempt_id: "ca_server",
            secret: "s".repeat(40),
            expires_at: new Date(Date.now() + 60_000).toISOString()
          }
        : url.endsWith("/poll")
          ? { status: "approved", credential: "orch_cli_" + "c".repeat(32) }
          : { projects: [] };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" }
      });
    };
    await resolveSetupAuthorization(
      {
        api,
        fetch,
        open: async (url) => {
          opened.push(url);
        },
        sleep: async () => undefined
      },
      store
    );
    assert.ok(values.has(cliAccount(api)));
    return opened;
  };
  delete process.env.ORCHESTRAT_WEB_URL;
  assert.deepEqual(await approve("http://localhost:8801/"), [
    "http://localhost:8801/cli/authorize?attempt=ca_server"
  ]);
  process.env.ORCHESTRAT_WEB_URL = "";
  assert.deepEqual(await approve("https://orchestrat.example.com"), [
    "https://orchestrat.example.com/cli/authorize?attempt=ca_server"
  ]);
  process.env.ORCHESTRAT_WEB_URL = "http://localhost:8813/auth/callback";
  assert.deepEqual(await approve("http://localhost:8801"), [
    "http://localhost:8813/cli/authorize?attempt=ca_server"
  ]);
});

test("status and doctor show the server, or say none is configured", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-server-status-"));
  const cwd = join(home, "project");
  await mkdir(cwd);
  const credentials = new MemoryCredentialReader();
  const empty = await runStatus({ home, cwd, credentials });
  assert.deepEqual(empty.servers, []);
  const lines: string[] = [];
  renderStatus(empty, (text) => lines.push(text));
  assert.match(lines.join(""), /Server: not configured/);
  const unconfigured = await runDoctor({ home, cwd, credentials });
  assert.equal(unconfigured.checks.server?.ok, false);
  assert.match(
    unconfigured.checks.server?.detail ?? "",
    /orchestrat setup --server <url>/
  );
  assert.equal(unconfigured.checks.cli_credential?.ok, false);

  await mkdir(join(home, ".orchestrat"), { recursive: true });
  await writeFile(
    configPath(home),
    JSON.stringify({
      version: 1,
      projects: {
        [cwd]: {
          projectId: "p",
          apiUrl: "http://localhost:8801",
          integrations: { codex: { agentId: "a" } }
        }
      }
    })
  );
  const mapped = await runStatus({ home, cwd, credentials });
  assert.deepEqual(mapped.servers, ["http://localhost:8801"]);
  lines.length = 0;
  renderStatus(mapped, (text) => lines.push(text));
  assert.match(lines.join(""), /Server: http:\/\/localhost:8801\n/);
  const doctor = await runDoctor({ home, cwd, credentials });
  assert.deepEqual(doctor.checks.server, {
    ok: true,
    detail: "http://localhost:8801"
  });
  // ORCHESTRAT_API_URL (passed in as api) wins over the saved mapping.
  const overridden = await runStatus({
    home,
    cwd,
    credentials,
    api: "https://orchestrat.example.com"
  });
  assert.deepEqual(overridden.servers, ["https://orchestrat.example.com"]);
});

test("an unreachable server is named in the setup error", async () => {
  const store: CredentialStore = {
    read: async () => undefined,
    write: async () => undefined,
    remove: async () => undefined
  };
  await assert.rejects(
    resolveSetupAuthorization(
      {
        api: "http://localhost:8801",
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
        open: async () => undefined,
        sleep: async () => undefined
      },
      store
    ),
    {
      message:
        "Unable to reach the Orchestrat server at http://localhost:8801; check --server or ORCHESTRAT_API_URL"
    }
  );
});
