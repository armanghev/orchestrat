export type DerivedPresence = "online" | "stale" | "offline";

export function derivePresence(
  status: "online" | "offline",
  heartbeat: string | null,
  now = Date.now(),
  freshnessMs = 60_000
): DerivedPresence {
  if (status === "offline" || heartbeat === null) return "offline";
  const age = now - Date.parse(heartbeat);
  return age < freshnessMs ? "online" : "stale";
}
