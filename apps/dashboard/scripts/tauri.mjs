import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { registerDevAuthReceiver } from "./macos-dev-auth.mjs";
import { parseEnv } from "node:util";

const config = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")
);

function storageCsp(endpoint, apiUrl) {
  const origins = [];
  for (const [value, storage] of [
    [endpoint, true],
    [apiUrl, false]
  ]) {
    if (!value) continue;
    const url = new URL(value);
    const localApi =
      !storage &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (!localApi && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      url.hostname.includes("*")
    )
      throw new Error(
        "Storage and API URLs must be exact HTTPS origins; local API HTTP is allowed on loopback only."
      );
    origins.push(url.origin);
    if (!storage) origins.push(url.origin.replace(/^http/, "ws"));
  }
  if (!origins.length) return config.app.security.csp;
  return config.app.security.csp.replace(
    /connect-src([^;]*)/,
    (_directive, sources) =>
      `connect-src ${[...new Set([...sources.trim().split(/\s+/), ...origins])].join(" ")}`
  );
}

if (process.argv[2] === "--self-check") {
  assert.equal(storageCsp(), config.app.security.csp);
  const csp = storageCsp("https://account.r2.cloudflarestorage.com/");
  assert.match(
    csp,
    /connect-src[^;]* https:\/\/account\.r2\.cloudflarestorage\.com;/
  );
  assert.match(csp, /script-src 'self';/);
  assert.match(
    storageCsp(undefined, "http://localhost:8899"),
    /connect-src[^;]* http:\/\/localhost:8899 ws:\/\/localhost:8899;/
  );
  assert.throws(() => storageCsp(undefined, "http://untrusted.test"));
  for (const invalid of [
    "http://storage.test",
    "https://user:secret@storage.test",
    "https://storage.test/bucket",
    "https://storage.test/?token=x",
    "https://*.r2.cloudflarestorage.com"
  ])
    assert.throws(() => storageCsp(invalid));
  console.log("Native storage CSP checks passed.");
} else {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const readEnv = (relative) => {
    try {
      return parseEnv(readFileSync(new URL(relative, import.meta.url), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  };
  const root = readEnv("../../../.env");
  const local = { ...readEnv("../.env"), ...readEnv("../.env.local") };
  const apiUrl = process.env.VITE_API_URL ?? local.VITE_API_URL;
  // Browsers upload to the public endpoint; the rest are older names.
  const storageEndpoint = [
    "ORCHESTRAT_S3_PUBLIC_ENDPOINT",
    "ORCHESTRAT_S3_ENDPOINT",
    "DOCUMENT_STORAGE_S3_ENDPOINT"
  ]
    .map((name) => process.env[name] || root[name])
    .find(Boolean);
  const csp = storageCsp(storageEndpoint, apiUrl);
  const overrides = { app: { security: { csp } } };
  const env = { ...process.env };
  if (process.platform === "darwin" && args[0] === "dev") {
    const manifest = fileURLToPath(
      new URL("../src-tauri/Cargo.toml", import.meta.url)
    );
    const metadata = JSON.parse(
      execFileSync(
        "cargo",
        [
          "metadata",
          "--format-version",
          "1",
          "--no-deps",
          "--offline",
          "--manifest-path",
          manifest
        ],
        { encoding: "utf8" }
      )
    );
    const targetIndex = args.indexOf("--target");
    const target = targetIndex === -1 ? "" : args[targetIndex + 1];
    const profile = args.includes("--release") ? "release" : "debug";
    registerDevAuthReceiver(
      join(metadata.target_directory, target, profile, "orchestrat-dashboard"),
      join(homedir(), "Applications")
    );
    overrides.identifier = config.identifier + ".development";
    overrides.productName = "Orchestrat Dev";
    env.VITE_DESKTOP_DEV = "1";
    env.ORCHESTRAT_AUTH_ENVIRONMENT = "development";
    env.ORCHESTRAT_DESKTOP_AUTH_PORTAL_URL = new URL(
      "/auth/desktop",
      config.build.devUrl
    ).href;
  }
  const result = spawnSync(
    "pnpm",
    ["exec", "tauri", ...args, "--config", JSON.stringify(overrides)],
    { stdio: "inherit", env }
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
