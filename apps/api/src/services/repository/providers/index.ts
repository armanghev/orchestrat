import type { RepositoryConfig } from "@orchestrat/config";
import type { ProviderAdapter } from "../types.js";
import { GithubAdapter } from "./github.js";

/** The adapters for every fully configured provider (setup guide §0.4). */
export function providerAdapters(config: RepositoryConfig): ProviderAdapter[] {
  const adapters: ProviderAdapter[] = [];
  if (config.github) adapters.push(new GithubAdapter(config.github));
  return adapters;
}
