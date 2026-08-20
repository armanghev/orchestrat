import type { SupportedStorage } from "@supabase/supabase-js";

const providerTokenKeys = new Set(["provider_token", "provider_refresh_token"]);
const maxSerializedLength = 1_000_000;
const maxNodes = 10_000;
const maxDepth = 64;

function sanitizedJson(value: string): string | null {
  if (value.length === 0 || value.length > maxSerializedLength) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const stack: Array<{ value: unknown; depth: number }> = [
      { value: parsed, depth: 0 }
    ];
    let nodes = 0;
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || ++nodes > maxNodes || current.depth > maxDepth)
        return null;
      if (current.value === null || typeof current.value !== "object") continue;
      if (Array.isArray(current.value)) {
        for (const child of current.value)
          stack.push({ value: child, depth: current.depth + 1 });
        continue;
      }
      for (const key of Object.keys(current.value)) {
        if (providerTokenKeys.has(key)) {
          delete (current.value as Record<string, unknown>)[key];
        } else {
          stack.push({
            value: (current.value as Record<string, unknown>)[key],
            depth: current.depth + 1
          });
        }
      }
    }
    const serialized = JSON.stringify(parsed);
    return typeof serialized === "string" &&
      serialized.length <= maxSerializedLength
      ? serialized
      : null;
  } catch {
    return null;
  }
}

export class ProviderTokenStrippingStorage implements SupportedStorage {
  constructor(
    private readonly storage: Pick<
      Storage,
      "getItem" | "setItem" | "removeItem"
    >
  ) {}

  getItem(key: string): string | null {
    let value: string | null;
    try {
      value = this.storage.getItem(key);
    } catch {
      return null;
    }
    if (value === null) return null;
    const safeValue = sanitizedJson(value);
    if (safeValue === null) {
      this.quarantine(key);
      return null;
    }
    try {
      this.storage.setItem(key, safeValue);
      return safeValue;
    } catch {
      this.quarantine(key);
      return null;
    }
  }

  setItem(key: string, value: string): void {
    const safeValue = sanitizedJson(value);
    if (safeValue === null) {
      this.quarantine(key);
      return;
    }
    try {
      this.storage.setItem(key, safeValue);
    } catch {
      this.quarantine(key);
    }
  }

  removeItem(key: string): void {
    this.quarantine(key);
  }

  private quarantine(key: string): void {
    try {
      this.storage.removeItem(key);
    } catch {
      /* Storage cleanup is best-effort and contains no auth value. */
    }
  }
}
