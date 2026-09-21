import assert from "node:assert/strict";
import test from "node:test";
import { consentedEvent, consentStorageKey, readConsent } from "./consent";

test("analytics is opt-in, revocable, and defaults off for unavailable or invalid storage", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    for (const value of [null, "", "true", "accepted", "rejected"]) {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          localStorage: {
            getItem(key: string) {
              assert.equal(key, consentStorageKey);
              return value;
            }
          }
        }
      });
      assert.equal(
        readConsent(),
        value === "accepted" || value === "rejected" ? value : null
      );
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage() {
          throw new Error("Storage blocked");
        }
      }
    });
    assert.equal(readConsent(), null);
    const event = { type: "pageview", url: "https://orchestrat.dev/guides" };
    for (const choice of [null, "rejected", "accepted", "rejected"] as const) {
      assert.equal(
        consentedEvent(event, choice),
        choice === "accepted" ? event : null
      );
    }
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
