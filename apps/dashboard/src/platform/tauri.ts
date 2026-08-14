import type { Platform, Unsubscribe } from "./contract";
import { preferencesSchema } from "./preferences";

const preferencesKey = "preferences";
const callbackDedupeWindowMs = 30_000;

export function normalizeAuthCallback(input: string): URL {
  const url = new URL(input);
  if (
    url.protocol !== "dev.orchestrat.app:" ||
    url.hostname !== "auth" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/callback" ||
    url.hash !== ""
  ) {
    throw new Error("Unexpected authentication callback.");
  }
  return url;
}

async function loadPreferencesStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load("preferences.json");
}

export function createTauriPlatform(): Platform {
  return {
    kind: "desktop",
    preferences: {
      async load() {
        const store = await loadPreferencesStore();
        return store.get<unknown>(preferencesKey);
      },
      async save(value) {
        const preferences = preferencesSchema.parse(value);
        const store = await loadPreferencesStore();
        await store.set(preferencesKey, preferences);
        await store.save();
      }
    },
    async openExternal(url) {
      if (url.origin !== "https://orchestrat.dev") {
        throw new Error("Only orchestrat.dev URLs can be opened externally.");
      }
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },
    async onAuthCallback(handler): Promise<Unsubscribe> {
      const { getCurrent, onOpenUrl } = await import(
        "@tauri-apps/plugin-deep-link"
      );
      const seen = new Map<string, number>();

      const handle = (input: string) => {
        let url: URL;
        try {
          url = normalizeAuthCallback(input);
        } catch {
          return;
        }

        const now = Date.now();
        for (const [value, receivedAt] of seen) {
          if (now - receivedAt >= callbackDedupeWindowMs) seen.delete(value);
        }
        const key = url.toString();
        if (seen.has(key)) return;
        seen.set(key, now);
        handler(url);
      };

      const unlisten = await onOpenUrl((urls) => urls.forEach(handle));
      try {
        const currentUrls = await getCurrent();
        currentUrls?.forEach(handle);
        return unlisten;
      } catch (error) {
        unlisten();
        throw error;
      }
    }
  };
}
