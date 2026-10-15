import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { loadApiConfig, loadRepositoryConfig } from "@orchestrat/config";
import { createDatabase, migrateDatabase, users } from "@orchestrat/db";
import { logger } from "@orchestrat/logger";
import { buildApp } from "./app.js";
import { readDocumentStorageConfig } from "./document-storage-config.js";
import { providerAdapters } from "./services/repository/providers/index.js";
import { SecretBox } from "./services/repository/secrets.js";
import { createShutdownHandler } from "./services/shutdown.js";

loadEnv({ path: "../../.env" });

const config = loadApiConfig();
const repositoryConfig = loadRepositoryConfig();
const repositorySecrets = repositoryConfig.secretKey
  ? new SecretBox(
      repositoryConfig.secretKey,
      repositoryConfig.previousSecretKeys
    )
  : null;
const { db, pool } = createDatabase({
  connectionString: config.ORCHESTRAT_DATABASE_URL,
  connectionTimeoutMillis: 2_000
});
const dashboardDir = config.ORCHESTRAT_DASHBOARD_DIR;
if (dashboardDir && !existsSync(join(dashboardDir, "index.html"))) {
  logger.error(
    { dashboard_dir: dashboardDir },
    "ORCHESTRAT_DASHBOARD_DIR has no index.html; build the dashboard first."
  );
  process.exit(1);
}
const setupToken =
  config.ORCHESTRAT_SETUP_TOKEN ?? randomBytes(24).toString("base64url");
const avatarBucket = process.env.SUPABASE_AVATAR_BUCKET;
const documentStorage = readDocumentStorageConfig();
const s3Endpoint = process.env.SUPABASE_S3_ENDPOINT;
const s3Region = process.env.SUPABASE_S3_REGION;
const s3AccessKeyId = process.env.SUPABASE_S3_ACCESS_KEY_ID;
const s3SecretAccessKey = process.env.SUPABASE_S3_SECRET_ACCESS_KEY;
const app = buildApp({
  allowedOrigins: config.ORCHESTRAT_ALLOWED_ORIGINS,
  signupMode: config.ORCHESTRAT_SIGNUP,
  dashboardDir,
  setupToken,
  checkDatabase: async () => {
    const query = { text: "select 1", query_timeout: 2_000 };
    await pool.query(query);
  },
  closeDatabase: () => pool.end(),
  db,
  avatarStorage:
    avatarBucket && s3Endpoint && s3Region && s3AccessKeyId && s3SecretAccessKey
      ? {
          bucket: avatarBucket,
          endpoint: s3Endpoint,
          region: s3Region,
          accessKeyId: s3AccessKeyId,
          secretAccessKey: s3SecretAccessKey,
          publicUrlBase: `${s3Endpoint.replace(/\/storage\/v1\/s3\/?$/, "")}/storage/v1/object/public/${avatarBucket}`
        }
      : undefined,
  documentStorage,
  repository: {
    config: repositoryConfig,
    adapters: providerAdapters(repositoryConfig, repositorySecrets),
    secrets: repositorySecrets
  },
  trustProxyHops: config.ORCHESTRAT_TRUST_PROXY_HOPS
});
const shutdown = createShutdownHandler(() => app.close());
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  if (config.ORCHESTRAT_MIGRATE_ON_START) {
    await migrateDatabase(db, pool);
    logger.info({}, "Database migrations are up to date");
  }
  await app.listen({
    host: config.ORCHESTRAT_API_HOST,
    port: config.ORCHESTRAT_API_PORT
  });
  logger.info({ port: config.ORCHESTRAT_API_PORT }, "API listening");
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  if (!anyUser) {
    const local = `http://localhost:${config.ORCHESTRAT_API_PORT}`;
    const dashboard =
      config.ORCHESTRAT_PUBLIC_URL ??
      (dashboardDir
        ? local
        : (repositoryConfig.dashboardUrl ??
          config.ORCHESTRAT_ALLOWED_ORIGINS[0] ??
          local));
    const setupUrl = config.ORCHESTRAT_SETUP_TOKEN
      ? `${dashboard}/`
      : `${dashboard}/?setup_token=${setupToken}`;
    logger.info(
      { setup_url: setupUrl },
      config.ORCHESTRAT_SETUP_TOKEN
        ? `No accounts yet. Create the admin account at ${setupUrl} with ORCHESTRAT_SETUP_TOKEN.`
        : `No accounts yet. Create the admin account at ${setupUrl}`
    );
  }
} catch (error) {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    "API failed to start"
  );
  await app.close();
  process.exitCode = 1;
}
