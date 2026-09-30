import { AgentApiError } from "@orchestrat/sdk";
import { setTaskStatusRequestSchema } from "@orchestrat/protocol";
import { z } from "zod";
import type { AttentionToolHost } from "./attention-tools.js";

// set_task_status (spec §9, §12). Uses the process-local claim token, like
// release_task and complete_task; review ends the claim, so its token is
// dropped only after the server accepts it.
export function registerStatusTool(host: AttentionToolHost): void {
  host.server.registerTool(
    "set_task_status",
    {
      description:
        "Set the status of a task this session has claimed: in_progress, blocked (needs a reason; name blocked_on and/or blocking_task_id so the block resolves itself when they respond or the task is done) or review (ends the claim; on TASK_COMMENTS_UNREAD read the comments and retry with acknowledged_through). While blocked, call wait_for_update instead of ending your turn.",
      inputSchema: {
        task_id: z.string().uuid(),
        status: z.enum(["in_progress", "blocked", "review"]),
        reason: z.string().trim().min(1).max(500).optional(),
        blocked_on: z
          .object({ type: z.enum(["human", "agent"]), id: z.string().uuid() })
          .optional(),
        blocking_task_id: z.string().uuid().optional(),
        acknowledged_through: z.number().int().nonnegative().optional()
      }
    },
    async ({ task_id, ...input }) =>
      host.call(async () => {
        const token = host.claims.get(task_id);
        if (!token)
          throw new AgentApiError(
            400,
            "CLAIM_NOT_FOUND",
            "No local claim token for this task."
          );
        const parsed = setTaskStatusRequestSchema.safeParse({
          claim_token: token,
          ...input
        });
        if (!parsed.success)
          throw new AgentApiError(
            400,
            "VALIDATION_ERROR",
            parsed.error.issues[0]?.message ?? "Invalid status request."
          );
        const result = await host
          .client()
          .attention.setStatus(host.requireSession(), parsed.data);
        if (input.status === "review") host.claims.take(task_id);
        return result;
      })
  );
}
