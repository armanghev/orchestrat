import type { Platform, Unsubscribe } from "./contract";
import { preferencesSchema } from "./preferences";

const preferencesKey = "preferences";
const callbackDedupeWindowMs = 30_000;

export function normalizeAuthCallback(input: string): URL {
  const invalid = () => { throw new Error("Unexpected authentication callback."); };
  let url: URL;
  try {
    // URLSearchParams decodes malformed percent escapes lossily, so validate the raw URL first.
    decodeURI(input);
    url = new URL(input);
  } catch { return invalid(); }
  if (
    url.protocol !== "dev.orchestrat.app:" || url.hostname !== "auth" ||
    url.port !== "" || url.username !== "" || url.password !== "" ||
    url.pathname !== "/callback" || url.hash !== ""
  ) return invalid();

  const allowed = new Set(["sb_flow_id", "code", "error", "error_code", "error_description"]);
  const values = new Map<string, string[]>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key)) return invalid();
    const entries = values.get(key) ?? [];
    entries.push(value);
    values.set(key, entries);
  }
  const one = (key: string, maximum: number, pattern?: RegExp): string | null => {
    const entries = values.get(key);
    if (!entries) return null;
    if (entries.length !== 1 || entries[0].length === 0 || entries[0].length > maximum ||
        [...entries[0]].some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; }) || (pattern && !pattern.test(entries[0]))) invalid();
    return entries[0];
  };
  const flow = one("sb_flow_id", 128, /^[A-Za-z0-9_-]+$/u);
  const code = one("code", 2048);
  const error = one("error", 128, /^[A-Za-z0-9._-]+$/u);
  one("error_code", 128, /^[A-Za-z0-9._-]+$/u);
  one("error_description", 512);
  if (!flow || (Boolean(code) === Boolean(error)) ||
      (code && (values.has("error_code") || values.has("error_description")))) return invalid();
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
        // Retain only the nonsecret correlation identifier for dedupe; never retain auth codes.
        const key = url.searchParams.get("sb_flow_id") as string;
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
