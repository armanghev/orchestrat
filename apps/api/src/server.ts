import { config as loadEnv } from "dotenv";
import { createClerkAuth } from "@orchestrat/auth";
import { loadApiConfig } from "@orchestrat/config";
import { createDatabase } from "@orchestrat/db";
import { logger } from "@orchestrat/logger";
import { buildApp } from "./app.js";

loadEnv({ path: "../../.env" });

const config = loadApiConfig();
const { db, pool } = createDatabase({
  connectionString: config.ORCHESTRAT_DATABASE_URL
});
const auth = createClerkAuth({
  authorizedParties: config.ORCHESTRAT_ALLOWED_ORIGINS,
  publishableKey: config.ORCHESTRAT_CLERK_PUBLISHABLE_KEY,
  secretKey: config.ORCHESTRAT_CLERK_SECRET_KEY
});
const app = buildApp({
  allowedOrigins: config.ORCHESTRAT_ALLOWED_ORIGINS,
  auth,
  closeDatabase: () => pool.end(),
  db
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
