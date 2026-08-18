import { config as loadEnv } from "dotenv";
import { createSupabaseAuth } from "@orchestrat/auth";
import { loadApiConfig } from "@orchestrat/config";
import { createDatabase } from "@orchestrat/db";
import { logger } from "@orchestrat/logger";
import { buildApp } from "./app.js";

loadEnv({ path: "../../.env" });

const config = loadApiConfig();
const { db, pool } = createDatabase({
  connectionString: config.ORCHESTRAT_DATABASE_URL
});
const auth = createSupabaseAuth({
  algorithm: config.ORCHESTRAT_SUPABASE_JWT_ALGORITHM,
  audience: config.ORCHESTRAT_SUPABASE_JWT_AUDIENCE,
  supabaseUrl: config.ORCHESTRAT_SUPABASE_URL
});
const avatarBucket = process.env.SUPABASE_AVATAR_BUCKET;
const s3Endpoint = process.env.SUPABASE_S3_ENDPOINT;
const s3Region = process.env.SUPABASE_S3_REGION;
const s3AccessKeyId = process.env.SUPABASE_S3_ACCESS_KEY_ID;
const s3SecretAccessKey = process.env.SUPABASE_S3_SECRET_ACCESS_KEY;
const app = buildApp({
  allowedOrigins: config.ORCHESTRAT_ALLOWED_ORIGINS,
  auth,
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
      : undefined
});

try {
  await app.listen({
    host: config.ORCHESTRAT_API_HOST,
    port: config.ORCHESTRAT_API_PORT
  });
  logger.info({ port: config.ORCHESTRAT_API_PORT }, "API listening");
} catch (error) {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    "API failed to start"
  );
  await app.close();
  process.exitCode = 1;
}
