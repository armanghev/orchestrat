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

/** Whether a presence entry counts as being on a branch. Older servers send
 * no branch_id; their agents count everywhere. */
export function onBranch(
  presence: { branch_id?: string | null },
  branchId: string | undefined
) {
  return (
    branchId === undefined ||
    presence.branch_id === undefined ||
    presence.branch_id === branchId
  );
}
