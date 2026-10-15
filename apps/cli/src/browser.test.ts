import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { browserCommand, openApprovalUrl, openBrowser } from "./browser.js";

const url = "http://localhost:8801/cli/authorize?attempt=ca_1&x=1";

class FakeChild extends EventEmitter {
  unrefed = false;
  unref() {
    this.unrefed = true;
    return this;
  }
}

// Never launches a real browser: the launcher process is simulated.
function fakeSpawn(behavior: (child: FakeChild) => void) {
  const calls: {
    command: string;
    args: readonly string[];
    options: SpawnOptions;
  }[] = [];
  const children: FakeChild[] = [];
  const spawn = (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    setImmediate(() => behavior(child));
    return child as unknown as ChildProcess;
  };
  return { spawn, calls, children };
}

test("each platform opens the browser with its own launcher", () => {
  assert.deepEqual(browserCommand(url, "darwin"), {
    command: "open",
    args: [url],
    options: {}
  });
  for (const platform of ["linux", "freebsd"] as const)
    assert.deepEqual(browserCommand(url, platform), {
      command: "xdg-open",
      args: [url],
      options: {}
    });
  assert.deepEqual(browserCommand(url, "win32"), {
    command: "cmd",
    args: [
      "/c",
      "start",
      '""',
      "http://localhost:8801/cli/authorize?attempt=ca_1^&x=1"
    ],
    options: { windowsVerbatimArguments: true }
  });
});

test("a launcher that is missing or fails means the browser did not open", async () => {
  const exits = fakeSpawn((child) => child.emit("exit", 0));
  assert.equal(
    await openBrowser(url, { platform: "linux", spawn: exits.spawn }),
    true
  );
  assert.equal(exits.calls[0]!.command, "xdg-open");
  assert.equal(exits.calls[0]!.options.detached, true);
  assert.equal(exits.calls[0]!.options.stdio, "ignore");
  for (const behavior of [
    (child: FakeChild) =>
      child.emit(
        "error",
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      ),
    (child: FakeChild) => child.emit("exit", 3)
  ])
    assert.equal(
      await openBrowser(url, {
        platform: "linux",
        spawn: fakeSpawn(behavior).spawn
      }),
      false
    );
  assert.equal(
    await openBrowser(url, {
      platform: "linux",
      spawn: () => {
        throw new Error("spawn failed");
      }
    }),
    false
  );
  const refused = fakeSpawn((child) => child.emit("exit", 0));
  assert.equal(
    await openBrowser("-x http://localhost:8801", { spawn: refused.spawn }),
    false
  );
  assert.equal(refused.calls.length, 0);
});

test("a launcher that keeps running counts as opened and is let go", async () => {
  const waiting = fakeSpawn(() => undefined);
  assert.equal(
    await openBrowser(url, {
      platform: "linux",
      spawn: waiting.spawn,
      settleMs: 5
    }),
    true
  );
  assert.equal(waiting.children[0]!.unrefed, true);
});

test("the approval URL is printed when no browser opens", async () => {
  const written: string[] = [];
  await openApprovalUrl(url, (text) => written.push(text), {
    platform: "linux",
    spawn: fakeSpawn((child) => child.emit("exit", 4)).spawn
  });
  assert.equal(
    written.join(""),
    `orchestrat: could not open a browser. Open this URL to approve the CLI:\n  ${url}\n`
  );
  written.length = 0;
  await openApprovalUrl(url, (text) => written.push(text), {
    platform: "darwin",
    spawn: fakeSpawn((child) => child.emit("exit", 0)).spawn
  });
  assert.deepEqual(written, []);
});
