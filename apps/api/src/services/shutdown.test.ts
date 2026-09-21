import assert from "node:assert/strict";
import test from "node:test";
import { createShutdownHandler } from "./shutdown.js";

test("shutdown drains once across repeated signals", async () => {
  let closes = 0;
  const handler = createShutdownHandler(
    async () => {
      closes += 1;
    },
    100,
    () => assert.fail("graceful close should not force exit")
  );
  handler("SIGTERM");
  handler("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
});

test("shutdown forces a bounded nonzero exit when draining stalls", async () => {
  const code = await new Promise<number>((resolve) => {
    createShutdownHandler(
      () => new Promise(() => undefined),
      5,
      resolve
    )("SIGTERM");
  });
  assert.equal(code, 1);
});
