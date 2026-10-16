import {
  branchNameSchema,
  branchResponseSchema,
  branchesResponseSchema,
  idParamsSchema,
  registerBranchRequestSchema,
  registerBranchResponseSchema
} from "@orchestrat/protocol";
import type { RegisterBranchRequest } from "@orchestrat/protocol";
import type { RequestFn } from "./attention.js";

export type {
  Branch,
  RegisterBranchRequest,
  RegisterBranchResponse
} from "@orchestrat/protocol";

type BranchListInput = { include_archived?: boolean; name?: string };

/**
 * The agent's view of its project's branches. Agents list, look up and register
 * branches; archiving, merging and the default branch belong to owners and
 * admins in the dashboard.
 */
export class BranchesApi {
  constructor(private readonly request: RequestFn) {}

  list(query: BranchListInput = {}) {
    const params = new URLSearchParams();
    if (query.include_archived) params.set("include_archived", "true");
    // URLSearchParams percent-encodes names such as feat/login.
    if (query.name !== undefined)
      params.set("name", branchNameSchema.parse(query.name));
    const search = params.toString();
    return this.request(
      "GET",
      `/branches${search ? `?${search}` : ""}`,
      branchesResponseSchema,
      undefined,
      true
    );
  }

  get(branchId: string) {
    const id = idParamsSchema.parse({ id: branchId }).id;
    return this.request(
      "GET",
      `/branches/${encodeURIComponent(id)}`,
      branchResponseSchema,
      undefined,
      true
    );
  }

  /**
   * Returns the active branch with this name, creating it when there is
   * none. Safe to retry: a second call finds the branch the first created.
   */
  register(input: RegisterBranchRequest) {
    return this.request(
      "POST",
      "/branches/register",
      registerBranchResponseSchema,
      registerBranchRequestSchema.parse(input),
      true
    );
  }
}
