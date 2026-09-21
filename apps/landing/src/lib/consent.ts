export const consentStorageKey = "orchestrat:analytics-consent:v1";
export type AnalyticsConsent = "accepted" | "rejected" | null;

export function readConsent(): AnalyticsConsent {
  try {
    const value = window.localStorage.getItem(consentStorageKey);
    return value === "accepted" || value === "rejected" ? value : null;
  } catch {
    return null;
  }
}

export function consentedEvent<T>(
  event: T,
  consent: AnalyticsConsent
): T | null {
  return consent === "accepted" ? event : null;
}
