import { z } from "zod";

// Repository connection settings (docs/project-branches-provider-setup.md
// §0.4). A provider counts as configured only when the shared repository
// settings and all of its own required variables are set.

const optional = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

export const repositoryEnvSchema = z.object({
  ORCHESTRAT_PUBLIC_API_URL: optional.pipe(z.string().url().optional()),
  ORCHESTRAT_DASHBOARD_URL: optional.pipe(z.string().url().optional()),
  ORCHESTRAT_REPOSITORY_SECRET_KEY: optional,
  ORCHESTRAT_REPOSITORY_SECRET_KEY_ID: optional.pipe(
    z
      .string()
      .regex(/^[a-z0-9]{1,16}$/)
      .optional()
  ),
  ORCHESTRAT_REPOSITORY_PREVIOUS_SECRET_KEYS: optional,
  ORCHESTRAT_REPOSITORY_SYNC_ENABLED: optional.pipe(
    z.enum(["true", "false"]).optional()
  ),
  ORCHESTRAT_REPOSITORY_RECONCILE_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .default(900),
  ORCHESTRAT_GITHUB_APP_ID: optional,
  ORCHESTRAT_GITHUB_APP_CLIENT_ID: optional,
  ORCHESTRAT_GITHUB_APP_CLIENT_SECRET: optional,
  ORCHESTRAT_GITHUB_APP_SLUG: optional,
  ORCHESTRAT_GITHUB_APP_PRIVATE_KEY_BASE64: optional,
  ORCHESTRAT_GITHUB_APP_WEBHOOK_SECRET: optional.pipe(
    z.string().min(32).optional()
  ),
  ORCHESTRAT_GITLAB_OAUTH_CLIENT_ID: optional,
  ORCHESTRAT_GITLAB_OAUTH_CLIENT_SECRET: optional,
  ORCHESTRAT_ORIGIN_APP_ID: optional,
  ORCHESTRAT_ORIGIN_APP_PRIVATE_KEY_BASE64: optional,
  ORCHESTRAT_ORIGIN_API_BASE: optional.pipe(
    z.string().url().default("https://api.cursor.com/v1/origin")
  )
});

export type SecretKey = { id: string; key: Buffer };
export type RepositoryProviderName = "github" | "gitlab" | "origin";

export type RepositoryConfig = {
  publicApiUrl: string | null;
  dashboardUrl: string | null;
  secretKey: SecretKey | null;
  previousSecretKeys: SecretKey[];
  syncEnabled: boolean;
  reconcileIntervalSeconds: number;
  github: {
    appId: string;
    clientId: string;
    clientSecret: string;
    slug: string;
    privateKeyPem: string;
    webhookSecret: string;
  } | null;
  gitlab: { clientId: string; clientSecret: string } | null;
  origin: { appId: string; privateKeyPem: string; apiBase: string } | null;
  /** Why each provider's Connect button is off, or null when it's on. */
  unavailable: Record<RepositoryProviderName, string | null>;
};

const key = (value: string): Buffer | null => {
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 ? bytes : null;
};
const pem = (value: string) => Buffer.from(value, "base64").toString("utf8");

export function loadRepositoryConfig(
  env: NodeJS.ProcessEnv = process.env
): RepositoryConfig {
  const parsed = repositoryEnvSchema.parse(env);
  const secret = parsed.ORCHESTRAT_REPOSITORY_SECRET_KEY
    ? key(parsed.ORCHESTRAT_REPOSITORY_SECRET_KEY)
    : null;
  if (parsed.ORCHESTRAT_REPOSITORY_SECRET_KEY && !secret)
    throw new Error(
      "ORCHESTRAT_REPOSITORY_SECRET_KEY must be 32 bytes, base64"
    );
  const previousSecretKeys = (
    parsed.ORCHESTRAT_REPOSITORY_PREVIOUS_SECRET_KEYS ?? ""
  )
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, value] = entry.split(":");
      const bytes = value ? key(value) : null;
      if (!id || !/^[a-z0-9]{1,16}$/.test(id) || !bytes)
        throw new Error(
          "ORCHESTRAT_REPOSITORY_PREVIOUS_SECRET_KEYS must be id:base64,…"
        );
      return { id, key: bytes };
    });
  const shared =
    !parsed.ORCHESTRAT_PUBLIC_API_URL || !parsed.ORCHESTRAT_DASHBOARD_URL
      ? "Set ORCHESTRAT_PUBLIC_API_URL and ORCHESTRAT_DASHBOARD_URL."
      : !secret || !parsed.ORCHESTRAT_REPOSITORY_SECRET_KEY_ID
        ? "Set ORCHESTRAT_REPOSITORY_SECRET_KEY and ORCHESTRAT_REPOSITORY_SECRET_KEY_ID."
        : null;
  const missing = (names: (keyof typeof parsed)[]) => {
    const absent = names.filter((name) => !parsed[name]);
    return absent.length ? `Set ${absent.join(", ")}.` : null;
  };
  const githubMissing = missing([
    "ORCHESTRAT_GITHUB_APP_ID",
    "ORCHESTRAT_GITHUB_APP_CLIENT_ID",
    "ORCHESTRAT_GITHUB_APP_CLIENT_SECRET",
    "ORCHESTRAT_GITHUB_APP_SLUG",
    "ORCHESTRAT_GITHUB_APP_PRIVATE_KEY_BASE64",
    "ORCHESTRAT_GITHUB_APP_WEBHOOK_SECRET"
  ]);
  const gitlabMissing = missing([
    "ORCHESTRAT_GITLAB_OAUTH_CLIENT_ID",
    "ORCHESTRAT_GITLAB_OAUTH_CLIENT_SECRET"
  ]);
  const originMissing = missing([
    "ORCHESTRAT_ORIGIN_APP_ID",
    "ORCHESTRAT_ORIGIN_APP_PRIVATE_KEY_BASE64"
  ]);
  const unavailable = {
    github: shared ?? githubMissing,
    gitlab: shared ?? gitlabMissing,
    origin: shared ?? originMissing
  };
  const anyConfigured = Object.values(unavailable).some((reason) => !reason);
  return {
    publicApiUrl: parsed.ORCHESTRAT_PUBLIC_API_URL ?? null,
    dashboardUrl: parsed.ORCHESTRAT_DASHBOARD_URL ?? null,
    secretKey:
      secret && parsed.ORCHESTRAT_REPOSITORY_SECRET_KEY_ID
        ? { id: parsed.ORCHESTRAT_REPOSITORY_SECRET_KEY_ID, key: secret }
        : null,
    previousSecretKeys,
    syncEnabled:
      parsed.ORCHESTRAT_REPOSITORY_SYNC_ENABLED === undefined
        ? anyConfigured
        : parsed.ORCHESTRAT_REPOSITORY_SYNC_ENABLED === "true",
    reconcileIntervalSeconds:
      parsed.ORCHESTRAT_REPOSITORY_RECONCILE_INTERVAL_SECONDS,
    github: unavailable.github
      ? null
      : {
          appId: parsed.ORCHESTRAT_GITHUB_APP_ID!,
          clientId: parsed.ORCHESTRAT_GITHUB_APP_CLIENT_ID!,
          clientSecret: parsed.ORCHESTRAT_GITHUB_APP_CLIENT_SECRET!,
          slug: parsed.ORCHESTRAT_GITHUB_APP_SLUG!,
          privateKeyPem: pem(parsed.ORCHESTRAT_GITHUB_APP_PRIVATE_KEY_BASE64!),
          webhookSecret: parsed.ORCHESTRAT_GITHUB_APP_WEBHOOK_SECRET!
        },
    gitlab: unavailable.gitlab
      ? null
      : {
          clientId: parsed.ORCHESTRAT_GITLAB_OAUTH_CLIENT_ID!,
          clientSecret: parsed.ORCHESTRAT_GITLAB_OAUTH_CLIENT_SECRET!
        },
    origin: unavailable.origin
      ? null
      : {
          appId: parsed.ORCHESTRAT_ORIGIN_APP_ID!,
          privateKeyPem: pem(parsed.ORCHESTRAT_ORIGIN_APP_PRIVATE_KEY_BASE64!),
          apiBase: parsed.ORCHESTRAT_ORIGIN_API_BASE
        },
    unavailable
  };
}
