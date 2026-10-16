import type { RepositoryConfig } from "@orchestrat/config";
import type { SecretBox } from "../secrets.js";
import type { ProviderAdapter } from "../types.js";
import { GithubAdapter } from "./github.js";
import { GitlabAdapter } from "./gitlab.js";
import { OriginAdapter } from "./origin.js";

/** The adapters for every fully configured provider. */
export function providerAdapters(
  config: RepositoryConfig,
  secrets: SecretBox | null
): ProviderAdapter[] {
  const adapters: ProviderAdapter[] = [];
  if (!secrets || !config.publicApiUrl) return adapters;
  if (config.github) adapters.push(new GithubAdapter(config.github));
  if (config.gitlab)
    adapters.push(
      new GitlabAdapter(config.gitlab, secrets, config.publicApiUrl)
    );
  if (config.origin) adapters.push(new OriginAdapter(config.origin));
  return adapters;
}
