import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions
} from "node:crypto";

export type AuthHeaders =
  | Headers
  | Record<string, string | string[] | undefined>
  | Iterable<readonly [string, string]>;

export type AuthRequest = {
  headers: AuthHeaders;
  method: string;
  url: string;
};

export type HumanPrincipal = {
  authSubject: string;
  avatarUrl: string | null;
  email: string;
  name: string | null;
  provider: string;
  username: string | null;
  // Set when the session already resolved the account, so the API can skip
  // the provider/subject lookup.
  userId?: string;
};

export type HumanAuth = {
  authenticate(request: AuthRequest): Promise<HumanPrincipal | null>;
};

export class AuthInfrastructureError extends Error {
  constructor() {
    super("Human identity verification is unavailable.");
    this.name = "AuthInfrastructureError";
  }
}

function headerEntries(headers: AuthHeaders) {
  if (headers instanceof Headers) return headers.entries();
  return Symbol.iterator in headers
    ? headers
    : Object.entries(headers as Record<string, string | string[] | undefined>);
}

// The single bearer token, or null when the header is missing, repeated or
// malformed.
export function exactBearer(headers: AuthHeaders) {
  let authorization: string | undefined;
  let count = 0;
  for (const [name, value] of headerEntries(headers)) {
    if (name.toLowerCase() !== "authorization") continue;
    count += 1;
    if (typeof value !== "string") return null;
    authorization = value;
  }
  if (count !== 1) return null;
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? null;
}

// Opaque tokens: a readable prefix plus 32 random bytes. Only their SHA-256
// hashes are stored.
export const ACCESS_TOKEN_PREFIX = "orch_sess_";
export const REFRESH_TOKEN_PREFIX = "orch_refresh_";

export const generateToken = (prefix: string) =>
  `${prefix}${randomBytes(32).toString("base64url")}`;

export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;
export const isTokenWithPrefix = (value: string, prefix: string) =>
  value.startsWith(prefix) && TOKEN_BODY.test(value.slice(prefix.length));

// Passwords: scrypt with a per-password salt, stored as
// scrypt$<log2 N>$<r>$<p>$<salt>$<hash> (base64url).
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

export type ScryptParams = { logN: number; r: number; p: number };
const CURRENT_PARAMS: ScryptParams = { logN: 15, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

const scrypt = (password: string, salt: Buffer, { logN, r, p }: ScryptParams) =>
  new Promise<Buffer>((resolve, reject) => {
    const N = 2 ** logN;
    const options: ScryptOptions = { N, r, p, maxmem: 256 * N * r };
    scryptCallback(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      options,
      (error, key) => (error ? reject(error) : resolve(key))
    );
  });

export async function hashPassword(
  password: string,
  params: ScryptParams = CURRENT_PARAMS
) {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password, salt, params);
  return [
    "scrypt",
    params.logN,
    params.r,
    params.p,
    salt.toString("base64url"),
    key.toString("base64url")
  ].join("$");
}

function parseHash(stored: string) {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [logN, r, p] = parts.slice(1, 4).map(Number) as [
    number,
    number,
    number
  ];
  if (
    !Number.isInteger(logN) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    logN < 10 ||
    logN > 20 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16
  )
    return null;
  const salt = Buffer.from(parts[4]!, "base64url");
  const key = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 8 || key.length !== KEY_LENGTH) return null;
  return { params: { logN, r, p }, salt, key };
}

export type PasswordCheck = { valid: boolean; needsRehash: boolean };

export async function verifyPassword(
  password: string,
  stored: string
): Promise<PasswordCheck> {
  const parsed = parseHash(stored);
  if (!parsed) return { valid: false, needsRehash: false };
  const key = await scrypt(password, parsed.salt, parsed.params);
  const valid = timingSafeEqual(key, parsed.key);
  const needsRehash =
    valid &&
    (parsed.params.logN !== CURRENT_PARAMS.logN ||
      parsed.params.r !== CURRENT_PARAMS.r ||
      parsed.params.p !== CURRENT_PARAMS.p);
  return { valid, needsRehash };
}

// Burns the same scrypt work as a real check, so a login for an unknown
// email takes as long as one with a wrong password.
let dummyHash: Promise<string> | undefined;
export async function verifyPasswordAgainstDummy(password: string) {
  dummyHash ??= hashPassword("orchestrat-dummy-password");
  await verifyPassword(password, await dummyHash);
}
