import type { Platform } from "./contract";
import { preferencesSchema } from "./preferences";

const preferencesKey = "orchestrat.preferences.v1";

export function createBrowserPlatform(): Platform {
  return {
    kind: "web",
    preferences: {
      async load() {
        const saved = window.localStorage.getItem(preferencesKey);
        if (saved === null) return undefined;

        try {
          return JSON.parse(saved) as unknown;
        } catch {
          return undefined;
        }
      },
      async save(value) {
        const preferences = preferencesSchema.parse(value);
        window.localStorage.setItem(preferencesKey, JSON.stringify(preferences));
      }
    },
    async openExternal(url) {
      if (url.protocol !== "https:") {
        throw new Error("Only HTTPS URLs can be opened externally.");
      }
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    },
    async onAuthCallback() {
      return () => undefined;
    }
  };
}
