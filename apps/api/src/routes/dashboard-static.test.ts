import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Database } from "@orchestrat/db";
import { buildApp } from "../app.js";

async function dashboard() {
  const dir = await mkdtemp(join(tmpdir(), "orchestrat-dashboard-"));
  await mkdir(join(dir, "assets"));
  await writeFile(
    join(dir, "index.html"),
    "<!doctype html><title>Orchestrat</title>"
  );
  await writeFile(join(dir, "assets", "app-abc123.js"), "console.log(1)");
  await writeFile(join(dir, "favicon.ico"), "icon");
  return dir;
}

test("serves the built dashboard and falls back to it for client routes", async () => {
  const dir = await dashboard();
  const app = buildApp({
    allowedOrigins: [],
    auth: { authenticate: async () => null },
    db: {} as Database,
    dashboardDir: dir
  });
  try {
    for (const url of ["/", "/projects/abc/tasks", "/?setup_token=xyz"]) {
      const page = await app.inject({ method: "GET", url });
      assert.equal(page.statusCode, 200, url);
      assert.match(page.headers["content-type"]!, /text\/html/);
      assert.match(page.body, /<title>Orchestrat<\/title>/);
      assert.equal(page.headers["cache-control"], "no-cache");
      assert.equal(page.headers["x-frame-options"], "DENY");
    }

    const asset = await app.inject({
      method: "GET",
      url: "/assets/app-abc123.js"
    });
    assert.equal(asset.statusCode, 200);
    assert.equal(
      asset.headers["cache-control"],
      "public, max-age=31536000, immutable"
    );
    assert.equal(asset.headers["x-content-type-options"], "nosniff");

    const favicon = await app.inject({ method: "GET", url: "/favicon.ico" });
    assert.equal(favicon.statusCode, 200);
    assert.equal(favicon.headers["cache-control"], "no-cache");

    // API, health, missing files and non-GET requests keep their 404s.
    for (const url of [
      "/api/v1/nope",
      "/api",
      "/health/x",
      "/assets/stale-123.js",
      "/missing.png?v=1"
    ]) {
      const missing = await app.inject({ method: "GET", url });
      assert.equal(missing.statusCode, 404, url);
      assert.equal(missing.json().error.code, "NOT_FOUND");
    }
    const post = await app.inject({ method: "POST", url: "/projects" });
    assert.equal(post.statusCode, 404);
    assert.equal(post.json().error.code, "NOT_FOUND");
    assert.equal(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
      200
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("without a dashboard directory unknown paths are JSON 404s", async () => {
  const app = buildApp({
    allowedOrigins: [],
    auth: { authenticate: async () => null },
    db: {} as Database
  });
  try {
    const response = await app.inject({ method: "GET", url: "/projects/abc" });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});
