import { createHash } from "node:crypto";

// Fingerprints compare one logical item across branches field by field:
// `{ field: sha256(canonical value) }`.

export type Fingerprint = Record<string, string>;

/** JSON with object keys sorted, so equal values always hash equally. */
export function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

export const fingerprintOf = (values: Record<string, unknown>): Fingerprint =>
  Object.fromEntries(
    Object.entries(values).map(([field, value]) => [field, digest(value)])
  );

/** Fields whose hashes differ; every field when there is nothing to compare. */
export function changedFields(
  current: Fingerprint,
  base: Fingerprint | null | undefined
): string[] {
  const fields = new Set([...Object.keys(current), ...Object.keys(base ?? {})]);
  return [...fields]
    .filter((field) => !base || current[field] !== base[field])
    .sort();
}

export const sameFingerprint = (left: Fingerprint, right: Fingerprint) =>
  changedFields(left, right).length === 0;
