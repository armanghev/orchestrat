import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  credentialsFilePath,
  FallbackCredentialStore,
  FileCredentialStore,
  platformCredentialStore,
  SecretToolCredentialStore,
  type CommandRunner
} from "./credential-store.js";
import {
  agentAccount,
  cliAccount,
  KEYCHAIN_SERVICE,
  KeychainCredentialStore
} from "./keychain.js";

const mode = async (path: string) => (await stat(path)).mode & 0o777;

// Stands in for libsecret's secret-tool; tests never run the real one.
function fakeSecretTool(initial: "working" | "missing" | "broken") {
  let state = initial;
  const items = new Map<string, string>();
  const calls: { args: readonly string[]; input?: string }[] = [];
  const run: CommandRunner = async (command, args, input) => {
    assert.equal(command, "secret-tool");
    calls.push({ args, input });
    if (state === "missing")
      throw Object.assign(new Error("spawn secret-tool ENOENT"), {
        code: "ENOENT"
      });
    if (state === "broken")
      return {
        code: 1,
        stdout: "",
        stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n"
      };
    assert.deepEqual(args.slice(-4, -2), ["service", KEYCHAIN_SERVICE]);
    const account = args.at(-1)!;
    if (args[0] === "store") items.set(account, input ?? "");
    if (args[0] === "clear") items.delete(account);
    if (args[0] === "lookup" && !items.has(account))
      return { code: 1, stdout: "", stderr: "" };
    return {
      code: 0,
      stdout: args[0] === "lookup" ? items.get(account)! : "",
      stderr: ""
    };
  };
  return {
    run,
    items,
    calls,
    set: (next: typeof state) => {
      state = next;
    }
  };
}

test("the credentials file lives under XDG_CONFIG_HOME, else ~/.config", () => {
  assert.equal(
    credentialsFilePath({ XDG_CONFIG_HOME: "/xdg" }, "/home/me"),
    "/xdg/orchestrat/credentials.json"
  );
  for (const XDG_CONFIG_HOME of [undefined, "", "relative/config"])
    assert.equal(
      credentialsFilePath({ XDG_CONFIG_HOME }, "/home/me"),
      "/home/me/.config/orchestrat/credentials.json"
    );
});

test("the file store keeps one key per API origin in a 0600 file inside a 0700 directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-credentials-"));
  const path = credentialsFilePath({ XDG_CONFIG_HOME: join(root, "xdg") });
  const store = new FileCredentialStore(path);
  assert.equal(
    await store.read(cliAccount("http://localhost:8801")),
    undefined
  );
  await store.write(cliAccount("http://localhost:8801/"), "local-cli");
  await store.write(cliAccount("https://orchestrat.example.com"), "remote-cli");
  await store.write(
    agentAccount("p", "codex", "http://localhost:8801"),
    "local-agent"
  );
  assert.equal(await mode(path), 0o600);
  assert.equal(await mode(dirname(path)), 0o700);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    version: 1,
    credentials: {
      "cli:http://localhost:8801": "local-cli",
      "cli:https://orchestrat.example.com": "remote-cli",
      "agent:p:codex:http://localhost:8801": "local-agent"
    }
  });
  await store.remove(cliAccount("http://localhost:8801"));
  await store.remove("never-stored");
  assert.equal(
    await store.read(cliAccount("http://localhost:8801")),
    undefined
  );
  assert.equal(
    await store.read(cliAccount("https://orchestrat.example.com")),
    "remote-cli"
  );
  assert.equal(
    await new FileCredentialStore(path).read(
      agentAccount("p", "codex", "http://localhost:8801/")
    ),
    "local-agent"
  );
});

test("the file store replaces the file atomically and tightens loose permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-credentials-atomic-"));
  const path = join(root, "orchestrat", "credentials.json");
  await mkdir(dirname(path), { mode: 0o755 });
  await chmod(dirname(path), 0o755);
  await writeFile(
    path,
    JSON.stringify({ version: 1, credentials: { existing: "kept" } })
  );
  await chmod(path, 0o644);
  const before = await stat(path);
  const store = new FileCredentialStore(path);
  await store.write("cli:http://localhost:8801", "secret");
  const after = await stat(path);
  // A new file was renamed into place rather than rewritten in place.
  assert.notEqual(after.ino, before.ino);
  assert.equal(await mode(path), 0o600);
  assert.equal(await mode(dirname(path)), 0o700);
  assert.deepEqual(await readdir(dirname(path)), ["credentials.json"]);
  assert.equal(await store.read("existing"), "kept");

  // A file the store cannot parse is never overwritten.
  const malformed = '{"version":1,"credentials":';
  await writeFile(path, malformed);
  await assert.rejects(store.write("cli:x", "synthetic-secret"), (error) => {
    assert.match(String(error), /malformed/);
    assert.doesNotMatch(String(error), /synthetic-secret/);
    return true;
  });
  assert.equal(await readFile(path, "utf8"), malformed);
  assert.deepEqual(await readdir(dirname(path)), ["credentials.json"]);
});

test("platform selection: macOS Keychain, Linux secret-tool with a file fallback, a file elsewhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-credentials-platform-"));
  const env = { XDG_CONFIG_HOME: join(root, "xdg") };
  const path = credentialsFilePath(env);
  assert.ok(
    platformCredentialStore({ platform: "darwin", env }) instanceof
      KeychainCredentialStore
  );
  const linux = platformCredentialStore({ platform: "linux", env });
  assert.ok(linux instanceof FallbackCredentialStore);
  assert.ok(linux.primary instanceof SecretToolCredentialStore);
  assert.ok(linux.fallback instanceof FileCredentialStore);
  assert.equal(linux.fallback.path, path);
  for (const platform of ["win32", "freebsd"] as const) {
    const other = platformCredentialStore({ platform, env });
    assert.ok(other instanceof FileCredentialStore);
    assert.equal(other.path, path);
  }
});

test("Linux uses a working secret-tool and passes secrets on stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-credentials-secret-tool-"));
  const env = { XDG_CONFIG_HOME: join(root, "xdg") };
  const tool = fakeSecretTool("working");
  const warnings: string[] = [];
  const store = platformCredentialStore({
    platform: "linux",
    env,
    run: tool.run,
    warn: (message) => warnings.push(message)
  });
  const account = agentAccount("p", "codex", "http://localhost:8801");
  await store.write(account, "synthetic-secret");
  assert.deepEqual(tool.calls[0], {
    args: [
      "store",
      "--label=Orchestrat CLI credential",
      "service",
      KEYCHAIN_SERVICE,
      "account",
      "agent:p:codex:http://localhost:8801"
    ],
    input: "synthetic-secret"
  });
  assert.ok(tool.calls.every(({ args }) => !args.includes("synthetic-secret")));
  assert.equal(await store.read(account), "synthetic-secret");
  await store.remove(account);
  assert.equal(tool.items.size, 0);
  assert.equal(await store.read(account), undefined);
  await assert.rejects(stat(credentialsFilePath(env)), { code: "ENOENT" });
  assert.deepEqual(warnings, []);
});

test("Linux falls back to the file when secret-tool is missing or broken", async () => {
  for (const state of ["missing", "broken"] as const) {
    const root = await mkdtemp(join(tmpdir(), `orch-credentials-${state}-`));
    const env = { XDG_CONFIG_HOME: join(root, "xdg") };
    const path = credentialsFilePath(env);
    const tool = fakeSecretTool(state);
    const warnings: string[] = [];
    const store = platformCredentialStore({
      platform: "linux",
      env,
      run: tool.run,
      warn: (message) => warnings.push(message)
    });
    const account = cliAccount("http://localhost:8801");
    await store.write(account, "file-secret");
    assert.equal(await mode(path), 0o600);
    assert.equal(await store.read(account), "file-secret");
    // secret-tool is tried once per process, then skipped.
    assert.equal(tool.calls.length, 1);
    assert.deepEqual(warnings, []);

    // A later process with a working secret-tool still finds the file copy,
    // and a new write moves it into secret-tool.
    tool.set("working");
    const later = platformCredentialStore({
      platform: "linux",
      env,
      run: tool.run
    });
    assert.equal(await later.read(account), "file-secret");
    await later.write(account, "keyring-secret");
    assert.equal(tool.items.get(account), "keyring-secret");
    assert.equal(await new FileCredentialStore(path).read(account), undefined);
    assert.equal(await later.read(account), "keyring-secret");
  }
});

test("secret-tool failures are sanitized and a missing item reads as absent", async () => {
  const results: Record<string, Awaited<ReturnType<CommandRunner>>> = {};
  const store = new SecretToolCredentialStore(
    async (_command, args) => results[args[0]!]!
  );
  results.lookup = { code: 1, stdout: "", stderr: "" };
  assert.equal(await store.read("account"), undefined);
  results.lookup = { code: 0, stdout: "token\n", stderr: "" };
  assert.equal(await store.read("account"), "token");
  results.lookup = { code: 1, stdout: "", stderr: "No such secret collection" };
  await assert.rejects(store.read("account"), {
    message: "Unable to read Orchestrat credential from secret-tool"
  });
  results.store = { code: 1, stdout: "", stderr: "synthetic-secret refused" };
  await assert.rejects(store.write("account", "synthetic-secret"), {
    message: "Unable to write Orchestrat credential to secret-tool"
  });
  results.clear = { code: 1, stdout: "", stderr: "" };
  await store.remove("account");
  results.clear = { code: null, stdout: "", stderr: "" };
  await assert.rejects(store.remove("account"), /Unable to remove/);
});

test("other platforms warn once, when the credentials file is created", async () => {
  for (const platform of ["win32", "freebsd"] as const) {
    const root = await mkdtemp(join(tmpdir(), `orch-credentials-${platform}-`));
    const env = { XDG_CONFIG_HOME: join(root, "xdg") };
    const path = credentialsFilePath(env);
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    const store = platformCredentialStore({ platform, env, warn });
    assert.equal(await store.read("cli:http://localhost:8801"), undefined);
    assert.equal(warnings.length, 0);
    await store.write("cli:http://localhost:8801", "synthetic-secret");
    await store.write("cli:https://orchestrat.example.com", "other");
    await platformCredentialStore({ platform, env, warn }).write(
      "agent:p:codex:http://localhost:8801",
      "agent"
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, new RegExp(platform));
    assert.ok(warnings[0]!.includes(path));
    assert.doesNotMatch(warnings[0]!, /synthetic-secret/);
    assert.equal(await mode(path), 0o600);
  }
});
