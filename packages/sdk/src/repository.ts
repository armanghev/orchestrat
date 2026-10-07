import { repositoryProvidersResponseSchema } from "@orchestrat/protocol";
import type { RequestFn } from "./attention.js";

/** Supply a human-authenticated transport whose paths are relative to /api/v1. */
export class RepositoryApi {
  constructor(private readonly request: RequestFn) {}

  listProviders() {
    return this.request(
      "GET",
      "/repository/providers",
      repositoryProvidersResponseSchema,
      undefined,
      true
    );
  }
}
