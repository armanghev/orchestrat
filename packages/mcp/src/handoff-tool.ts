import {
  attentionParticipantRefSchema,
  createHandoffRequestSchema
} from "@orchestrat/protocol";
import { z } from "zod";
import type { AttentionToolHost } from "./attention-tools.js";

// handoff (ORC-15): a direct message plus a handoffs row, so the recipient sees
// it as a pending, directed attention item.
export function registerHandoffTool(host: AttentionToolHost): void {
  host.server.registerTool(
    "handoff",
    {
      description:
        "Hand work to another agent or a human: sends them a direct message marked as a handoff, optionally referencing a task, and keeps it pending in their attention until they acknowledge it. Find recipients with list_message_candidates. Supply a stable idempotency_key and reuse it with the same request after an ambiguous response. Handoff chains and rates are limited; on a limit error, ask a human instead of handing off again.",
      inputSchema: {
        to: attentionParticipantRefSchema,
        message: createHandoffRequestSchema.shape.body_markdown,
        task_id: z.string().uuid().optional(),
        idempotency_key: z.string().trim().min(1).max(128)
      }
    },
    async ({ to, message, task_id, idempotency_key }) =>
      host.call(() =>
        host.client().attention.handoff(
          createHandoffRequestSchema.parse({
            to,
            body_markdown: message,
            ...(task_id ? { task_id } : {})
          }),
          idempotency_key
        )
      )
  );
}
