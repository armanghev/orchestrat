import { loadApiConfig } from "@orchestrat/config";
import { logger } from "@orchestrat/logger";
import { buildApp } from "./app.js";

const config = loadApiConfig();
const app = buildApp();

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
  process.exit(1);
}
