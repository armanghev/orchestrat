import {
  organizationParamsSchema,
  projectSummariesResponseSchema
} from "@orchestrat/protocol";
import type { RequestFn } from "./attention.js";

/** Supply a human-authenticated transport whose paths are relative to /api/v1. */
export class ProjectsApi {
  constructor(private readonly request: RequestFn) {}

  listProjectSummaries(organizationId: string) {
    const id = organizationParamsSchema.parse({
      organizationId
    }).organizationId;
    return this.request(
      "GET",
      `/organizations/${encodeURIComponent(id)}/project-summaries`,
      projectSummariesResponseSchema,
      undefined,
      true
    );
  }
}
