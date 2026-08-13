import type { ErrorCode } from "@orchestrat/protocol";

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}
