import { readStorageConfig } from "./storage-config.js";
import type { DocumentStorageConfig } from "./services/document-service.js";

/** @deprecated Use readStorageConfig; kept until server.ts moves over. */
export type DocumentStorageConfigValues = DocumentStorageConfig;

/** @deprecated Use readStorageConfig(env).documentStorage. */
export function readDocumentStorageConfig(
  env: NodeJS.ProcessEnv = process.env
): DocumentStorageConfigValues | undefined {
  return readStorageConfig(env).documentStorage;
}
