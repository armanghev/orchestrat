import { randomUUID } from "node:crypto";
import {
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  exactBearer,
  generateToken,
  hashPassword,
  hashToken,
  isTokenWithPrefix,
  verifyPassword,
  verifyPasswordAgainstDummy,
  type AuthHeaders,
  type HumanAuth,
  type HumanPrincipal
} from "@orchestrat/auth";
import {
  authSessions,
  instanceSettings,
  projectInvitations,
  userPasswords,
  users,
  type Database
} from "@orchestrat/db";
import type {
  AuthSessionResponse,
  ChangePasswordRequest,
  LoginRequest,
  SignupMode,
  SignupRequest
} from "@orchestrat/protocol";
import { and, asc, eq, gt, isNull, lt, ne, or } from "drizzle-orm";
import { ApiError } from "./api-error.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type User = typeof users.$inferSelect;

export type AuthServiceOptions = {
  signupMode: SignupMode;
  now?: () => Date;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  // A refresh token presented again within this window of its rotation is
  // treated as a race between tabs, not as theft.
  refreshReuseGraceSeconds?: number;
};

const USER_AGENT_MAX_LENGTH = 512;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const invalidCredentials = () =>
  new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
const invalidRefreshToken = () =>
  new ApiError(
    401,
    "REFRESH_TOKEN_INVALID",
    "The session has ended. Sign in again."
  );

// The API is its own identity provider: email + password accounts and
// opaque session tokens (only their hashes are stored). It also serves as
// the HumanAuth for every signed-in route.
export class AuthService implements HumanAuth {
  private readonly now: () => Date;
  private readonly accessTtlMs: number;
  private readonly refreshTtlMs: number;
  private readonly reuseGraceMs: number;

  constructor(
    private readonly db: Database,
    private readonly options: AuthServiceOptions
  ) {
    this.now = options.now ?? (() => new Date());
    this.accessTtlMs = (options.accessTtlSeconds ?? 3600) * 1000;
    this.refreshTtlMs = (options.refreshTtlSeconds ?? 30 * 24 * 3600) * 1000;
    this.reuseGraceMs = (options.refreshReuseGraceSeconds ?? 60) * 1000;
  }

  async instance() {
    return {
      needs_setup: !(await this.anyUser(this.db)),
      signup_mode: this.options.signupMode
    };
  }

  async signup(
    input: SignupRequest,
    userAgent?: string
  ): Promise<AuthSessionResponse> {
    const passwordHash = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      const emptyInstance = !(await this.anyUser(tx));
      const [taken] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);
      if (taken)
        throw new ApiError(
          409,
          "EMAIL_TAKEN",
          "An account with that email already exists."
        );
      if (!emptyInstance) await this.assertSignupAllowed(tx, input);

      const id = randomUUID();
      const [created] = await tx
        .insert(users)
        .values({
          id,
          authProvider: "local",
          authSubject: id,
          email: input.email,
          name: input.full_name
        })
        .returning();
      await tx.insert(userPasswords).values({ userId: id, passwordHash });

      let user = created!;
      if (emptyInstance) {
        // Whoever records the bootstrap row on an empty instance becomes its
        // first admin; a concurrent signup that loses falls back to the
        // normal signup rules.
        const bootstrapped = await tx
          .insert(instanceSettings)
          .values({ id: 1, bootstrappedBy: id })
          .onConflictDoNothing()
          .returning({ id: instanceSettings.id });
        if (bootstrapped.length > 0) {
          [user] = await tx
            .update(users)
            .set({ isInstanceAdmin: true })
            .where(eq(users.id, id))
            .returning();
        } else {
          await this.assertSignupAllowed(tx, input);
        }
      }
      return this.createSession(tx, user!, userAgent);
    });
  }

  async login(
    input: LoginRequest,
    userAgent?: string
  ): Promise<AuthSessionResponse> {
    const [row] = await this.db
      .select({ user: users, passwordHash: userPasswords.passwordHash })
      .from(users)
      .innerJoin(userPasswords, eq(userPasswords.userId, users.id))
      .where(eq(users.email, input.email))
      .limit(1);
    if (!row) {
      await verifyPasswordAgainstDummy(input.password);
      throw invalidCredentials();
    }
    const check = await verifyPassword(input.password, row.passwordHash);
    if (!check.valid) throw invalidCredentials();
    const rehashed = check.needsRehash
      ? await hashPassword(input.password)
      : null;
    return this.db.transaction(async (tx) => {
      if (rehashed)
        await tx
          .update(userPasswords)
          .set({ passwordHash: rehashed, updatedAt: this.now() })
          .where(eq(userPasswords.userId, row.user.id));
      await this.pruneSessions(tx, row.user.id);
      return this.createSession(tx, row.user, userAgent);
    });
  }

  async refresh(
    refreshToken: string,
    userAgent?: string
  ): Promise<AuthSessionResponse> {
    if (!isTokenWithPrefix(refreshToken, REFRESH_TOKEN_PREFIX))
      throw invalidRefreshToken();
    const hash = hashToken(refreshToken);
    const result = await this.db.transaction(async (tx) => {
      const now = this.now();
      const [current] = await tx
        .select()
        .from(authSessions)
        .where(eq(authSessions.refreshTokenHash, hash))
        .for("update");
      if (current) {
        if (current.revokedAt || current.refreshExpiresAt <= now) return null;
        const user = await tx.query.users.findFirst({
          where: eq(users.id, current.userId)
        });
        if (!user) return null;
        return this.rotateSession(tx, current.id, hash, user, userAgent);
      }
      // A rotated-out refresh token came back. Within the grace window that's
      // two tabs refreshing at once; after it, assume the token leaked and
      // end the session.
      const [reused] = await tx
        .select()
        .from(authSessions)
        .where(eq(authSessions.previousRefreshTokenHash, hash))
        .for("update");
      if (
        reused &&
        !reused.revokedAt &&
        !(
          reused.rotatedAt &&
          now.getTime() - reused.rotatedAt.getTime() < this.reuseGraceMs
        )
      )
        await tx
          .update(authSessions)
          .set({ revokedAt: now })
          .where(eq(authSessions.id, reused.id));
      return null;
    });
    if (!result) throw invalidRefreshToken();
    return result;
  }

  // Ends the session the request was made with.
  async logout(headers: AuthHeaders) {
    const token = exactBearer(headers);
    if (!token) return;
    await this.db
      .update(authSessions)
      .set({ revokedAt: this.now() })
      .where(
        and(
          eq(authSessions.accessTokenHash, hashToken(token)),
          isNull(authSessions.revokedAt)
        )
      );
  }

  async logoutAll(userId: string) {
    await this.revokeSessions(this.db, userId);
  }

  // Ends every other session, so a stolen session can't outlive the change.
  async changePassword(
    userId: string,
    headers: AuthHeaders,
    input: ChangePasswordRequest
  ) {
    const [row] = await this.db
      .select({ passwordHash: userPasswords.passwordHash })
      .from(userPasswords)
      .where(eq(userPasswords.userId, userId))
      .limit(1);
    const check = row
      ? await verifyPassword(input.current_password, row.passwordHash)
      : (await verifyPasswordAgainstDummy(input.current_password),
        { valid: false });
    if (!check.valid)
      throw new ApiError(
        403,
        "PASSWORD_INCORRECT",
        "The current password is incorrect."
      );
    const passwordHash = await hashPassword(input.new_password);
    const current = exactBearer(headers);
    await this.db.transaction(async (tx) => {
      await tx
        .update(userPasswords)
        .set({ passwordHash, updatedAt: this.now() })
        .where(eq(userPasswords.userId, userId));
      await this.revokeSessions(
        tx,
        userId,
        current ? hashToken(current) : undefined
      );
    });
  }

  async authenticate(request: {
    headers: AuthHeaders;
  }): Promise<HumanPrincipal | null> {
    const token = exactBearer(request.headers);
    if (!token || !isTokenWithPrefix(token, ACCESS_TOKEN_PREFIX)) return null;
    const now = this.now();
    const [row] = await this.db
      .select({ session: authSessions, user: users })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(eq(authSessions.accessTokenHash, hashToken(token)))
      .limit(1);
    if (!row || row.session.revokedAt || row.session.accessExpiresAt <= now)
      return null;
    if (
      now.getTime() - row.session.lastUsedAt.getTime() >
      LAST_USED_WRITE_INTERVAL_MS
    )
      await this.db
        .update(authSessions)
        .set({ lastUsedAt: now })
        .where(eq(authSessions.id, row.session.id));
    return {
      authSubject: row.user.authSubject,
      avatarUrl: row.user.avatarUrl,
      email: row.user.email,
      name: row.user.name,
      provider: row.user.authProvider,
      username: row.user.username,
      userId: row.user.id
    };
  }

  // Admin operations, used by the orchestrat-admin command.

  async adminCreateUser(input: {
    email: string;
    fullName: string;
    password: string;
    admin?: boolean;
  }) {
    const passwordHash = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      const id = randomUUID();
      const [user] = await tx
        .insert(users)
        .values({
          id,
          authProvider: "local",
          authSubject: id,
          email: input.email,
          name: input.fullName,
          isInstanceAdmin: input.admin ?? false
        })
        .returning();
      await tx.insert(userPasswords).values({ userId: id, passwordHash });
      await tx
        .insert(instanceSettings)
        .values({ id: 1, bootstrappedBy: id })
        .onConflictDoNothing();
      return user!;
    });
  }

  // Sets a password and ends every session. Accounts from the hosted alpha
  // (provider "supabase") become local accounts here.
  async adminSetPassword(email: string, password: string) {
    const passwordHash = await hashPassword(password);
    return this.db.transaction(async (tx) => {
      const user = await this.userByEmail(tx, email);
      if (user.authProvider !== "local")
        await tx
          .update(users)
          .set({
            authProvider: "local",
            authSubject: user.id,
            updatedAt: this.now()
          })
          .where(eq(users.id, user.id));
      await tx
        .insert(userPasswords)
        .values({ userId: user.id, passwordHash })
        .onConflictDoUpdate({
          target: userPasswords.userId,
          set: { passwordHash, updatedAt: this.now() }
        });
      await this.revokeSessions(tx, user.id);
      return user;
    });
  }

  async adminSetInstanceAdmin(email: string, isInstanceAdmin: boolean) {
    const user = await this.userByEmail(this.db, email);
    await this.db
      .update(users)
      .set({ isInstanceAdmin, updatedAt: this.now() })
      .where(eq(users.id, user.id));
    return { ...user, isInstanceAdmin };
  }

  async adminListUsers() {
    return this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        provider: users.authProvider,
        isInstanceAdmin: users.isInstanceAdmin,
        hasPassword: userPasswords.userId,
        createdAt: users.createdAt
      })
      .from(users)
      .leftJoin(userPasswords, eq(userPasswords.userId, users.id))
      .orderBy(asc(users.createdAt));
  }

  async adminRevokeSessions(email: string) {
    const user = await this.userByEmail(this.db, email);
    await this.revokeSessions(this.db, user.id);
    return user;
  }

  private async anyUser(db: Database | Tx) {
    const [row] = await db.select({ id: users.id }).from(users).limit(1);
    return Boolean(row);
  }

  private async assertSignupAllowed(tx: Tx, input: SignupRequest) {
    if (this.options.signupMode === "open") return;
    if (this.options.signupMode === "closed")
      throw new ApiError(
        403,
        "SIGNUP_CLOSED",
        "This server doesn't allow new accounts. Ask an admin to create one."
      );
    if (!input.invite_token)
      throw new ApiError(
        403,
        "INVITE_REQUIRED",
        "You need an invite link to create an account on this server."
      );
    const [invitation] = await tx
      .select({ id: projectInvitations.id })
      .from(projectInvitations)
      .where(
        and(
          eq(projectInvitations.tokenHash, hashToken(input.invite_token)),
          isNull(projectInvitations.acceptedAt),
          isNull(projectInvitations.revokedAt),
          gt(projectInvitations.expiresAt, this.now())
        )
      )
      .limit(1);
    if (!invitation)
      throw new ApiError(
        403,
        "INVITE_REQUIRED",
        "This invite link is invalid or has expired."
      );
  }

  private async userByEmail(db: Database | Tx, email: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    if (!user)
      throw new ApiError(404, "NOT_FOUND", "No account has that email.");
    return user;
  }

  private async createSession(
    tx: Tx,
    user: User,
    userAgent: string | undefined
  ) {
    const now = this.now();
    const access = generateToken(ACCESS_TOKEN_PREFIX);
    const refresh = generateToken(REFRESH_TOKEN_PREFIX);
    await tx.insert(authSessions).values({
      userId: user.id,
      accessTokenHash: hashToken(access),
      refreshTokenHash: hashToken(refresh),
      accessExpiresAt: new Date(now.getTime() + this.accessTtlMs),
      refreshExpiresAt: new Date(now.getTime() + this.refreshTtlMs),
      userAgent: userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
      createdAt: now,
      lastUsedAt: now
    });
    return this.sessionResponse(user, access, refresh);
  }

  private async rotateSession(
    tx: Tx,
    sessionId: string,
    presentedHash: string,
    user: User,
    userAgent: string | undefined
  ) {
    const now = this.now();
    const access = generateToken(ACCESS_TOKEN_PREFIX);
    const refresh = generateToken(REFRESH_TOKEN_PREFIX);
    await tx
      .update(authSessions)
      .set({
        accessTokenHash: hashToken(access),
        refreshTokenHash: hashToken(refresh),
        previousRefreshTokenHash: presentedHash,
        accessExpiresAt: new Date(now.getTime() + this.accessTtlMs),
        refreshExpiresAt: new Date(now.getTime() + this.refreshTtlMs),
        rotatedAt: now,
        lastUsedAt: now,
        ...(userAgent
          ? { userAgent: userAgent.slice(0, USER_AGENT_MAX_LENGTH) }
          : {})
      })
      .where(eq(authSessions.id, sessionId));
    return this.sessionResponse(user, access, refresh);
  }

  private sessionResponse(
    user: User,
    accessToken: string,
    refreshToken: string
  ): AuthSessionResponse {
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: Math.round(this.accessTtlMs / 1000),
      refresh_expires_in: Math.round(this.refreshTtlMs / 1000),
      user: {
        user_id: user.id,
        email: user.email,
        full_name: user.name,
        is_instance_admin: user.isInstanceAdmin
      }
    };
  }

  private async revokeSessions(
    db: Database | Tx,
    userId: string,
    exceptAccessHash?: string
  ) {
    await db
      .update(authSessions)
      .set({ revokedAt: this.now() })
      .where(
        and(
          eq(authSessions.userId, userId),
          isNull(authSessions.revokedAt),
          exceptAccessHash
            ? ne(authSessions.accessTokenHash, exceptAccessHash)
            : undefined
        )
      );
  }

  // Drops this user's sessions that ended more than a week ago.
  private async pruneSessions(tx: Tx, userId: string) {
    const cutoff = new Date(this.now().getTime() - 7 * 24 * 3600 * 1000);
    await tx
      .delete(authSessions)
      .where(
        and(
          eq(authSessions.userId, userId),
          or(
            lt(authSessions.refreshExpiresAt, cutoff),
            lt(authSessions.revokedAt, cutoff)
          )
        )
      );
  }
}
