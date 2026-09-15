import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  KeychainCredentialStore,
  agentAccount,
  cliAccount
} from "./keychain.js";

// Intercept the native boundary; never access the user's Keychain.
test("Keychain writes pipe quoted secrets and sanitize every failure", async (t) => {
  let command = "";
  let failure: "none" | "exit" | "stderr" | "pipe" | "spawn" = "none";
  let calls = 0;
  t.mock.method(
    childProcess,
    "execFile",
    (
      file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      calls++;
      assert.equal(file, "/usr/bin/security");
      assert.deepEqual(args, ["-i"]);
      if (failure === "spawn")
        throw new Error("synthetic-secret spawn failure");
      const stdin = new PassThrough();
      command = "";
      stdin.on("data", (chunk) => {
        command += chunk;
      });
      stdin.on("finish", () => {
        if (failure === "pipe")
          stdin.emit("error", new Error("synthetic-secret pipe failure"));
        callback(
          failure === "exit"
            ? new Error("synthetic-secret command failed")
            : null,
          "",
          failure === "stderr" ? "synthetic-secret returned 1" : ""
        );
      });
      return { stdin };
    }
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const store = new KeychainCredentialStore("test service");
  for (const account of [
    cliAccount("https://api.test"),
    agentAccount("project", "codex", "https://api.test")
  ]) {
    await store.write(
      account,
      'synthetic-secret "quote" \\ slash; apostrophe\''
    );
    assert.ok(
      command.includes(
        '"-w" "synthetic-secret \\"quote\\" \\\\ slash; apostrophe\'"\n'
      )
    );
    for (const mode of ["exit", "stderr", "pipe", "spawn"] as const) {
      failure = mode;
      await assert.rejects(store.write(account, "synthetic-secret"), {
        message: "Unable to write Orchestrat credential to Keychain"
      });
    }
    failure = "none";
  }
  for (const value of [
    "secret\nhelp",
    "secret\rhelp",
    "secret\0help",
    "x".repeat(4096),
    "😀".repeat(1024)
  ]) {
    const before = calls;
    await assert.rejects(store.write("account", value), /Unable to write/);
    await assert.rejects(store.write(value, "secret"), /Unable to write/);
    await assert.rejects(
      new KeychainCredentialStore(value).write("account", "secret"),
      /Unable to write/
    );
    assert.equal(calls, before);
  }
});
