import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload
} from "jose";

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
  provider: "supabase";
};

export type HumanAuth = {
  authenticate(request: AuthRequest): Promise<HumanPrincipal | null>;
};

export type SupabaseJwtAlgorithm = "ES256" | "RS256";

export type SupabaseAuthOptions = {
  algorithm: SupabaseJwtAlgorithm;
  audience: string;
  supabaseUrl: string;
};

type SupabaseAuthDependencies = {
  keyResolver?: JWTVerifyGetKey;
};

const EMAIL_MAX_LENGTH = 320;
const NAME_MAX_LENGTH = 200;
const AVATAR_URL_MAX_LENGTH = 2048;
const JWKS_TIMEOUT_MS = 3_000;
const CLOCK_TOLERANCE_SECONDS = 5;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthInfrastructureError extends Error {
  constructor() {
    super("Human identity verification is unavailable.");
    this.name = "AuthInfrastructureError";
  }
}

function validateOptions(options: SupabaseAuthOptions) {
  if (options.algorithm !== "ES256" && options.algorithm !== "RS256") {
    throw new TypeError("Supabase JWT algorithm must be ES256 or RS256.");
  }

  const audience = options.audience.trim();
  if (!audience) throw new TypeError("Supabase JWT audience is required.");

  let url: URL;
  try {
    url = new URL(options.supabaseUrl);
  } catch {
    throw new TypeError("Supabase URL must be a valid HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Supabase URL must be a valid HTTPS origin.");
  }

  const baseUrl = url.origin;
  return {
    algorithm: options.algorithm,
    audience,
    issuer: `${baseUrl}/auth/v1`,
    jwksUrl: new URL(`${baseUrl}/auth/v1/.well-known/jwks.json`)
  };
}

function headerEntries(headers: AuthHeaders) {
  if (headers instanceof Headers) return headers.entries();
  return Symbol.iterator in headers
    ? headers
    : Object.entries(headers as Record<string, string | string[] | undefined>);
}

function exactBearer(headers: AuthHeaders) {
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

function normalizedEmail(value: unknown) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) return null;
  return EMAIL_PATTERN.test(email) ? email : null;
}

function metadata(payload: JWTPayload) {
  const value = payload.user_metadata;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedName(value: unknown) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name) return null;
  return Array.from(name).slice(0, NAME_MAX_LENGTH).join("");
}

function safeAvatarUrl(value: unknown) {
  if (typeof value !== "string") return null;
  const avatarUrl = value.trim();
  if (!avatarUrl || avatarUrl.length > AVATAR_URL_MAX_LENGTH) return null;
  try {
    const url = new URL(avatarUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const canonicalUrl = url.toString();
    return canonicalUrl.length <= AVATAR_URL_MAX_LENGTH ? canonicalUrl : null;
  } catch {
    return null;
  }
}

function principal(payload: JWTPayload): HumanPrincipal | null {
  if (
    payload.role !== "authenticated" ||
    typeof payload.sub !== "string" ||
    !UUID_PATTERN.test(payload.sub) ||
    typeof payload.iat !== "number" ||
    !Number.isInteger(payload.iat) ||
    payload.iat > Math.floor(Date.now() / 1000) + CLOCK_TOLERANCE_SECONDS
  ) {
    return null;
  }
  const email = normalizedEmail(payload.email);
  if (!email) return null;

  const userMetadata = metadata(payload);
  return {
    authSubject: payload.sub.toLowerCase(),
    avatarUrl: safeAvatarUrl(
      userMetadata.avatar_url ?? userMetadata.picture ?? payload.picture
    ),
    email,
    name: boundedName(
      userMetadata.full_name ?? userMetadata.name ?? payload.name
    ),
    provider: "supabase"
  };
}

const INVALID_CREDENTIAL_CODES = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID"
]);

function isInvalidCredential(error: unknown) {
  return (
    error instanceof errors.JOSEError &&
    INVALID_CREDENTIAL_CODES.has(error.code)
  );
}

export function createSupabaseAuth(
  options: SupabaseAuthOptions,
  dependencies: SupabaseAuthDependencies = {}
): HumanAuth {
  const validated = validateOptions(options);
  const keyResolver =
    dependencies.keyResolver ??
    createRemoteJWKSet(validated.jwksUrl, {
      timeoutDuration: JWKS_TIMEOUT_MS
    });

  return {
    async authenticate(request) {
      const bearer = exactBearer(request.headers);
      if (!bearer) return null;

      try {
        const { payload } = await jwtVerify(bearer, keyResolver, {
          algorithms: [validated.algorithm],
          audience: validated.audience,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          issuer: validated.issuer,
          requiredClaims: ["exp", "iat", "sub", "email", "role"]
        });
        return principal(payload);
      } catch (error) {
        if (isInvalidCredential(error)) return null;
        throw new AuthInfrastructureError();
      }
    }
  };
}
