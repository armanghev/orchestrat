import { S3Client } from "@aws-sdk/client-s3";

/** An S3-compatible bucket: MinIO, R2, AWS S3 and the like. */
export type S3ConnectionConfig = {
  /** The endpoint the API server itself calls. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** `endpoint/bucket/key` URLs instead of `bucket.endpoint/key`. Default true. */
  forcePathStyle?: boolean;
};

export function createS3Client(
  config: S3ConnectionConfig,
  endpoint = config.endpoint
) {
  return new S3Client({
    forcePathStyle: config.forcePathStyle ?? true,
    // By default the SDK signs a CRC32 of the (empty) body into presigned
    // upload URLs, so S3, MinIO and SeaweedFS reject the real upload; some
    // S3-compatible servers also lack the newer checksums. Only when required.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    region: config.region,
    endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}
