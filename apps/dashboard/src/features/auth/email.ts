const maximumEmailLength = 254;

export function normalizeAuthEmail(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximumEmailLength || [...trimmed].some((character) => character.charCodeAt(0) > 127)) return null;
  const email = trimmed.toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (local.length === 0 || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)) return null;
  if (domain.length === 0 || domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0 || label.length > 63 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label))) return null;
  return email;
}
