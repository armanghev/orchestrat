import type { DecisionReason } from "@orchestrat/protocol";

export const decisionReasons: Record<DecisionReason, string> = {
  changed_on_both: "Changed on both branches",
  added_on_both: "Added on both branches",
  path_collision: "Another document already uses this path",
  target_claimed: "An agent was working on it"
};
