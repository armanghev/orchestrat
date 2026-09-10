export type DocumentStorageConfigValues = {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

const documentKeys = [
  "DOCUMENT_STORAGE_BUCKET",
  "DOCUMENT_STORAGE_S3_ENDPOINT",
  "DOCUMENT_STORAGE_S3_REGION",
  "DOCUMENT_STORAGE_S3_ACCESS_KEY_ID",
  "DOCUMENT_STORAGE_S3_SECRET_ACCESS_KEY"
] as const;
const normalizeEndpoint = (value: string | undefined) =>
  value?.replace(/\/+$/, "");

export function readDocumentStorageConfig(
  env: NodeJS.ProcessEnv = process.env
): DocumentStorageConfigValues | undefined {
  const usesDedicatedConfig = documentKeys.some((key) => env[key]);
  const values = {
    bucket: env.DOCUMENT_STORAGE_BUCKET,
    endpoint: env.DOCUMENT_STORAGE_S3_ENDPOINT,
    region: env.DOCUMENT_STORAGE_S3_REGION,
    accessKeyId: env.DOCUMENT_STORAGE_S3_ACCESS_KEY_ID,
    secretAccessKey: env.DOCUMENT_STORAGE_S3_SECRET_ACCESS_KEY
  };

  if (!values.bucket && !usesDedicatedConfig) return undefined;
  if (Object.values(values).some((value) => !value))
    throw new Error("Document storage requires a complete S3 configuration.");
  const endpoint = new URL(values.endpoint!);
  if (
    endpoint.hostname.endsWith(".r2.cloudflarestorage.com") &&
    endpoint.pathname !== "/"
  )
    throw new Error(
      "The R2 endpoint must be the account origin without a bucket path; set DOCUMENT_STORAGE_BUCKET separately."
    );
  if (
    values.bucket === env.SUPABASE_AVATAR_BUCKET &&
    normalizeEndpoint(values.endpoint) ===
      normalizeEndpoint(env.SUPABASE_S3_ENDPOINT)
  )
    throw new Error("Document storage must not use the avatar bucket.");
  return values as DocumentStorageConfigValues;
}
