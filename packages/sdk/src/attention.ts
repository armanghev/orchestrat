import {
  acknowledgeAttentionRequestSchema,
  acknowledgeAttentionResponseSchema,
  attentionSummarySchema,
  createHandoffRequestSchema,
  createHandoffResponseSchema,
  idParamsSchema,
  recordWakeRequestSchema,
  recordWakeResponseSchema,
  setTaskStatusRequestSchema,
  setTaskStatusResponseSchema,
  taskWatchRequestSchema,
  taskWatchSchema,
  waitQuerySchema,
  waitResponseSchema
} from "@orchestrat/protocol";
import type {
  AcknowledgeAttentionRequest,
  CreateHandoffRequest,
  RecordWakeRequest,
  SetTaskStatusRequest,
  WaitQueryInput
} from "@orchestrat/protocol";

type Schema<T> = { parse(value: unknown): T };

// Mirrors AgentApiClient.request so the client can hand over a bound copy
// without making its transport public.
export type RequestFn = <T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  schema: Schema<T>,
  input?: unknown,
  retryable?: boolean,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal
) => Promise<T>;

export class AttentionApi {
  constructor(private readonly request: RequestFn) {}

  summary(signal?: AbortSignal) {
    return this.request(
      "GET",
      "/attention",
      attentionSummarySchema,
      undefined,
      true,
      {},
      signal
    );
  }

  acknowledge(input: AcknowledgeAttentionRequest) {
    return this.request(
      "POST",
      "/attention/acknowledge",
      acknowledgeAttentionResponseSchema,
      acknowledgeAttentionRequestSchema.parse(input)
    );
  }

  watch(taskId: string, watching: boolean) {
    const id = idParamsSchema.parse({ id: taskId }).id;
    return this.request(
      "POST",
      `/tasks/${encodeURIComponent(id)}/watch`,
      taskWatchSchema,
      taskWatchRequestSchema.parse({ watching })
    );
  }

  setStatus(sessionId: string, input: SetTaskStatusRequest) {
    return this.request(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/claims/status`,
      setTaskStatusResponseSchema,
      setTaskStatusRequestSchema.parse(input)
    );
  }

  wait(query: WaitQueryInput = {}, signal?: AbortSignal) {
    const parsed = waitQuerySchema.parse(query);
    const params = new URLSearchParams();
    if (parsed.after !== undefined) params.set("after", parsed.after);
    params.set("timeout_ms", String(parsed.timeout_ms));
    params.set("directed_only", String(parsed.directed_only));
    if (parsed.kinds) params.set("kinds", parsed.kinds.join(","));
    if (parsed.branch_id) params.set("branch_id", parsed.branch_id);
    return this.request(
      "GET",
      `/attention/wait?${params.toString()}`,
      waitResponseSchema,
      undefined,
      true,
      {},
      signal
    );
  }

  handoff(input: CreateHandoffRequest, idempotencyKey: string) {
    return this.request(
      "POST",
      "/handoffs",
      createHandoffResponseSchema,
      createHandoffRequestSchema.parse(input),
      false,
      { "idempotency-key": idempotencyKey }
    );
  }

  recordWake(input: RecordWakeRequest) {
    return this.request(
      "POST",
      "/wakes",
      recordWakeResponseSchema,
      recordWakeRequestSchema.parse(input)
    );
  }
}
