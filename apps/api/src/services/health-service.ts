import type { HealthResponse } from "@orchestrat/protocol";

export const getHealth = (): HealthResponse => ({ status: "ok" });
