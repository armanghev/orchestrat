import { describe, expect, it } from "vitest";
import { derivePresence } from "./presence";

describe("derivePresence", () => {
  const now = Date.parse("2024-01-01T00:01:00.000Z");
  it("keeps a heartbeat just inside the freshness boundary online", () => {
    expect(derivePresence("online", "2024-01-01T00:00:00.001Z", now)).toBe(
      "online"
    );
  });
  it("marks the exact freshness boundary stale", () => {
    expect(derivePresence("online", "2024-01-01T00:00:00.000Z", now)).toBe(
      "stale"
    );
  });
  it("marks a heartbeat beyond the boundary stale", () => {
    expect(derivePresence("online", "2023-12-31T23:59:59.999Z", now)).toBe(
      "stale"
    );
  });
  it("keeps missing or offline sessions offline", () => {
    expect(derivePresence("offline", null, now)).toBe("offline");
  });
});
