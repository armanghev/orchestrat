import { createHash } from "node:crypto";

export type NormalizedHook = {
  event: "session.started" | "session.ended" | "run.failed";
  session_id: string;
  external_session_id: string;
  runtime: string;
  integration: "codex" | "claude-code";
  error?: string;
};

export const deterministicSessionId = (
  integration: string,
  external: string
) => {
  const hex = createHash("sha256")
    .update(`${integration}\0${external}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
};
