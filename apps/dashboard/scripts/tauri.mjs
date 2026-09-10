import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  const csp = storageCsp(
    process.env.DOCUMENT_STORAGE_S3_ENDPOINT ??
      root.DOCUMENT_STORAGE_S3_ENDPOINT,
    apiUrl
  );
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "tauri",
      ...args,
      "--config",
      JSON.stringify({ app: { security: { csp } } })
    ],
    { stdio: "inherit" }
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
