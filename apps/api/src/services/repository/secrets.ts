import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretKey } from "@orchestrat/config";

// Stored provider secrets (docs/project-branches.md §8.1, §12): AES-256-GCM,
// `v1.<key_id>.<iv>.<ciphertext+tag>`, bound to a row and purpose through
// additional authenticated data, so a ciphertext copied elsewhere fails.

export const aad = (table: string, rowId: string, purpose: string) =>
  `${table}:${rowId}:${purpose}`;

export class SecretBox {
  private readonly keys: Map<string, Buffer>;
  constructor(
    private readonly current: SecretKey,
    previous: SecretKey[] = []
  ) {
    this.keys = new Map([
      ...previous.map((entry): [string, Buffer] => [entry.id, entry.key]),
      [current.id, current.key]
    ]);
  }

  /** Encrypts with the current key. */
  seal(plaintext: string, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.current.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
      cipher.getAuthTag()
    ]);
    return `v1.${this.current.id}.${iv.toString("base64url")}.${body.toString("base64url")}`;
  }

  /** Decrypts with whichever known key wrote it; throws on any mismatch. */
  open(ciphertext: string, context: string) {
    const [version, keyId, iv, body] = ciphertext.split(".");
    const key = keyId ? this.keys.get(keyId) : undefined;
    if (version !== "v1" || !key || !iv || !body)
      throw new Error("Unreadable secret.");
    const bytes = Buffer.from(body, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url")
    );
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - 16)),
      decipher.final()
    ]).toString("utf8");
  }
}
