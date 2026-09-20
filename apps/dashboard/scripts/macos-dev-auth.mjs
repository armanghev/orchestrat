import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// macOS sends URL Apple events to bundles, not the binary started by Tauri dev.
// Convert the event to the CLI handoff our single-instance handler already uses.
export function registerDevAuthReceiver(
  binary,
  directory,
  scheme = "dev.orchestrat.app.local"
) {
  mkdirSync(directory, { recursive: true });
  const bundle = join(directory, "Orchestrat Dev Auth.app");
  const source = [
    "on open location incomingUrl",
    "  if length of incomingUrl > 4096 then return",
    '  set devPrefix to "' + scheme + '://auth/callback?"',
    "  if incomingUrl does not start with devPrefix then return",
    '  set callbackUrl to "dev.orchestrat.app://auth/callback?" & text ((length of devPrefix) + 1) thru -1 of incomingUrl',
    "  do shell script quoted form of " +
      JSON.stringify(binary) +
      ' & " " & quoted form of callbackUrl & " >/dev/null 2>&1 &"',
    "end open location"
  ].join("\n");
  execFileSync("/usr/bin/osacompile", ["-o", bundle, "-"], { input: source });
  const plist = join(bundle, "Contents/Info.plist");
  execFileSync("/usr/bin/plutil", [
    "-replace",
    "CFBundleIdentifier",
    "-string",
    scheme,
    plist
  ]);
  execFileSync("/usr/bin/plutil", [
    "-replace",
    "LSUIElement",
    "-bool",
    "YES",
    plist
  ]);
  execFileSync("/usr/bin/plutil", [
    "-replace",
    "CFBundleURLTypes",
    "-json",
    JSON.stringify([
      {
        CFBundleTypeRole: "Viewer",
        CFBundleURLName: scheme,
        CFBundleURLSchemes: [scheme]
      }
    ]),
    plist
  ]);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", bundle], {
    stdio: "pipe"
  });
  execFileSync(lsregister, ["-f", bundle]);
  return bundle;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert.equal(process.argv[2], "--self-check");
  assert.equal(process.platform, "darwin");
  const applications = join(homedir(), "Applications");
  mkdirSync(applications, { recursive: true });
  const directory = mkdtempSync(
    join(applications, "orchestrat-dev-auth-check-")
  );
  const receipt = join(directory, "callback");
  const binary = join(directory, "test binary's name");
  const scheme = "dev.orchestrat.app.test" + process.pid;
  let bundle;
  try {
    writeFileSync(
      binary,
      "#!/bin/sh\nprintf '%s' \"$1\" > '" +
        receipt.replaceAll("'", "'\\''") +
        "'\n",
      { mode: 0o700 }
    );
    bundle = registerDevAuthReceiver(binary, directory, scheme);
    const query = "sb_flow_id=flow_123456789012&code=one-time";
    execFileSync("/usr/bin/open", [scheme + "://auth/callback?" + query]);
    let received;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        received = readFileSync(receipt, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (received) break;
      await setTimeout(100);
    }
    assert.equal(received, "dev.orchestrat.app://auth/callback?" + query);
    console.log("macOS URL event to dev binary callback check passed.");
  } finally {
    if (bundle) execFileSync(lsregister, ["-u", bundle]);
    rmSync(directory, { recursive: true, force: true });
  }
}
