import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient
} from "@supabase/supabase-js";
import {
  type AuthCapabilities,
  type AuthClient,
  type AuthCompletionResult,
  type AuthSnapshot,
  loadingAuthSnapshot,
  type TokenOptions
} from "./auth-client";
import { ProviderTokenStrippingStorage } from "./web-auth-storage";

type AuthResult<T> = Promise<{ data: T; error: unknown }>;

export type WebAuthApi = {
  onAuthStateChange(
    listener: (event: AuthChangeEvent, session: Session | null) => void
  ): {
    data: { subscription: { unsubscribe(): void } };
  };
  getSession(): AuthResult<{ session: Session | null }>;
  signInWithOAuth(credentials: {
    provider: "github";
    options: { redirectTo: string };
  }): Promise<{ data: unknown; error: unknown }>;
  signInWithOtp(credentials: {
    email: string;
    options: { emailRedirectTo: string; shouldCreateUser: true };
  }): Promise<{ data: unknown; error: unknown }>;
  exchangeCodeForSession(
    code: string
  ): AuthResult<{ session: Session | null; user: unknown }>;
  refreshSession(): AuthResult<{ session: Session | null; user: unknown }>;
  signOut(options: { scope: "local" }): Promise<{ error: unknown }>;
  dispose(): Promise<void>;
};

const webCapabilities: AuthCapabilities = Object.freeze({
  github: true,
  magicLink: true
});
const invalidCallbackError: AuthSnapshot = {
  status: "error",
  code: "invalid_callback",
  message: "We couldn't complete your sign-in. Try again."
};
const providerCallbackError: AuthSnapshot = {
  status: "error",
  code: "provider_error",
  message: "We couldn't complete your sign-in. Try again."
};

type ParsedCallback =
  | { kind: "code"; code: string }
  | { kind: "providerError" }
  | { kind: "invalid" };
type OperationContext = {
  generation: number;
  authEventVersion: number;
  operationEpoch: number;
};

function snapshotsEqual(left: AuthSnapshot, right: AuthSnapshot): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "error" && right.status === "error")
    return left.code === right.code && left.message === right.message;
  if (left.status === "signedIn" && right.status === "signedIn")
    return left.identityKey === right.identityKey;
  if (
    (left.status === "sendingMagicLink" || left.status === "magicLinkSent") &&
    (right.status === "sendingMagicLink" || right.status === "magicLinkSent")
  )
    return left.email === right.email;
  return true;
}

function normalizedEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)
  )
    return null;
  return email;
}

function safeCallbackValue(value: string, maxLength: number): boolean {
  if (value.length === 0 || value.length > maxLength) return false;
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });
}

function parseCallback(
  callbackUrl: string,
  configuredCallbackUrl: string
): ParsedCallback {
  let callback: URL;
  let configured: URL;
  try {
    callback = new URL(callbackUrl);
    configured = new URL(configuredCallbackUrl);
  } catch {
    return { kind: "invalid" };
  }
  if (
    callback.origin !== configured.origin ||
    callback.pathname !== configured.pathname ||
    callback.username ||
    callback.password ||
    callback.hash
  )
    return { kind: "invalid" };

  const allowed = new Set(["code", "error", "error_code", "error_description"]);
  const counts = new Map<string, number>();
  for (const [key] of callback.searchParams) {
    if (!allowed.has(key)) return { kind: "invalid" };
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if ([...counts.values()].some((count) => count !== 1))
    return { kind: "invalid" };

  const code = callback.searchParams.get("code");
  const error = callback.searchParams.get("error");
  const errorCode = callback.searchParams.get("error_code");
  const errorDescription = callback.searchParams.get("error_description");
  if (code !== null) {
    if (
      error !== null ||
      errorCode !== null ||
      errorDescription !== null ||
      !safeCallbackValue(code, 4096)
    )
      return { kind: "invalid" };
    return { kind: "code", code };
  }
  if (error !== null) {
    if (
      !safeCallbackValue(error, 256) ||
      (errorCode !== null && !safeCallbackValue(errorCode, 256)) ||
      (errorDescription !== null && !safeCallbackValue(errorDescription, 1024))
    )
      return { kind: "invalid" };
    return { kind: "providerError" };
  }
  return { kind: "invalid" };
}

export class WebAuthClient implements AuthClient {
  readonly capabilities = webCapabilities;
  private snapshot: AuthSnapshot = loadingAuthSnapshot;
  private session: Session | null = null;
  private readonly listeners = new Set<() => void>();
  private initialization: Promise<void> | null = null;
  private githubOperation: Promise<void> | null = null;
  private magicLinkOperation: Promise<void> | null = null;
  private callbackOperation: Promise<AuthCompletionResult> | null = null;
  private callbackAttempted = false;
  private refreshOperation: Promise<string | null> | null = null;
  private signOutOperation: Promise<void> | null = null;
  private authUnsubscribe: (() => void) | null = null;
  private generation = 0;
  private authEventVersion = 0;
  private operationEpoch = 0;
  private disposed = false;

  constructor(
    private readonly auth: WebAuthApi,
    private readonly callbackUrl: string
  ) {}

  initialize(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.initialization) this.initialization = this.initializeOnce();
    return this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    const generation = this.generation;
    const version = this.authEventVersion;
    const subscription = this.auth.onAuthStateChange((event, session) => {
      if (this.disposed) return;
      if (event === "SIGNED_OUT") {
        this.authEventVersion += 1;
        this.operationEpoch += 1;
        this.session = null;
        this.setSnapshot({ status: "signedOut" });
      } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        this.authEventVersion += 1;
        this.operationEpoch += 1;
        this.session = session;
        this.setSnapshot(
          session
            ? { status: "signedIn", identityKey: session.user.id }
            : { status: "signedOut" }
        );
      }
    }).data.subscription;
    if (this.disposed) {
      subscription.unsubscribe();
      return;
    }
    this.authUnsubscribe = () => subscription.unsubscribe();
    try {
      const result = await this.auth.getSession();
      if (result.error) throw result.error;
      if (
        !this.disposed &&
        generation === this.generation &&
        version === this.authEventVersion
      ) {
        this.session = result.data.session;
        this.setSnapshot(
          this.session
            ? { status: "signedIn", identityKey: this.session.user.id }
            : { status: "signedOut" }
        );
      }
    } catch {
      if (
        !this.disposed &&
        generation === this.generation &&
        this.snapshot.status === "loading"
      ) {
        this.setSnapshot({
          status: "error",
          code: "session_restore_failed",
          message: "Your session could not be restored. Try again."
        });
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.operationEpoch += 1;
    this.session = null;
    try {
      this.authUnsubscribe?.();
    } catch {
      /* Cleanup must continue without exposing provider details. */
    }
    this.authUnsubscribe = null;
    try {
      void this.auth.dispose().catch(() => undefined);
    } catch {
      /* Cleanup is best-effort and intentionally silent. */
    }
    this.listeners.clear();
  }

  getSnapshot(): AuthSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  signInWithGitHub(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.githubOperation) return this.githubOperation;
    const context = this.beginOperation();
    this.setSnapshot({ status: "signingIn" });
    const operation = this.auth
      .signInWithOAuth({
        provider: "github",
        options: { redirectTo: this.callbackUrl }
      })
      .then((result) => {
        if (result.error) throw result.error;
        if (this.canCommit(context)) this.callbackAttempted = false;
      })
      .catch(() => {
        if (this.canCommit(context)) {
          this.setSnapshot({
            status: "error",
            code: "oauth_start_failed",
            message: "Sign-in could not be started. Try again."
          });
        }
      })
      .finally(() => {
        if (this.githubOperation === operation) this.githubOperation = null;
      });
    this.githubOperation = operation;
    return operation;
  }

  sendMagicLink(value: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.magicLinkOperation) return this.magicLinkOperation;
    const email = normalizedEmail(value);
    if (!email) {
      this.setSnapshot({
        status: "error",
        code: "invalid_email",
        message: "Enter a valid email address."
      });
      return Promise.resolve();
    }
    const context = this.beginOperation();
    this.setSnapshot({ status: "sendingMagicLink", email });
    const operation = this.auth
      .signInWithOtp({
        email,
        options: { emailRedirectTo: this.callbackUrl, shouldCreateUser: true }
      })
      .then((result) => {
        if (result.error) throw result.error;
        if (this.canCommit(context)) {
          this.callbackAttempted = false;
          this.setSnapshot({ status: "magicLinkSent", email });
        }
      })
      .catch(() => {
        if (this.canCommit(context)) {
          this.setSnapshot({
            status: "error",
            code: "magic_link_failed",
            message: "The sign-in link could not be sent. Try again."
          });
        }
      })
      .finally(() => {
        if (this.magicLinkOperation === operation)
          this.magicLinkOperation = null;
      });
    this.magicLinkOperation = operation;
    return operation;
  }

  completeSignIn(callbackUrl: string): Promise<AuthCompletionResult> {
    if (this.disposed) return Promise.resolve({ status: "error" });
    if (this.callbackOperation) return this.callbackOperation;
    if (this.callbackAttempted) return Promise.resolve({ status: "error" });
    const parsed = parseCallback(callbackUrl, this.callbackUrl);
    const context = this.beginOperation();
    if (parsed.kind === "invalid") {
      this.setSnapshot(invalidCallbackError);
      return Promise.resolve({ status: "error" });
    }
    this.callbackAttempted = true;
    if (parsed.kind === "providerError") {
      this.setSnapshot(providerCallbackError);
      return Promise.resolve({ status: "error" });
    }
    this.setSnapshot({ status: "signingIn" });
    let request: ReturnType<WebAuthApi["exchangeCodeForSession"]>;
    try {
      request = this.auth.exchangeCodeForSession(parsed.code);
    } catch {
      if (this.canCommit(context)) {
        this.setSnapshot({
          status: "error",
          code: "callback_exchange_failed",
          message: "We couldn't complete your sign-in. Try again."
        });
      }
      return Promise.resolve({ status: "error" });
    }
    const operation: Promise<AuthCompletionResult> = request
      .then((result): AuthCompletionResult => {
        if (result.error || !result.data.session)
          throw result.error ?? new Error("Session missing");
        const identityKey = result.data.session.user.id;
        if (this.canCommit(context)) {
          this.session = result.data.session;
          this.setSnapshot({ status: "signedIn", identityKey });
          return { status: "success", identityKey };
        }
        if (
          this.authEventVersion !== context.authEventVersion &&
          this.session?.user.id === identityKey &&
          this.snapshot.status === "signedIn"
        )
          return { status: "success", identityKey };
        return { status: "error" };
      })
      .catch((): AuthCompletionResult => {
        if (this.canCommit(context)) {
          this.setSnapshot({
            status: "error",
            code: "callback_exchange_failed",
            message: "We couldn't complete your sign-in. Try again."
          });
        }
        return { status: "error" };
      })
      .finally(() => {
        if (this.callbackOperation === operation) this.callbackOperation = null;
      });
    this.callbackOperation = operation;
    return operation;
  }

  signOut(): Promise<void> {
    return this.clearLocalSession();
  }
  expireSession(): Promise<void> {
    return this.clearLocalSession();
  }

  private clearLocalSession(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.signOutOperation) return this.signOutOperation;
    this.generation += 1;
    this.operationEpoch += 1;
    this.session = null;
    this.githubOperation = null;
    this.magicLinkOperation = null;
    this.callbackOperation = null;
    this.setSnapshot({ status: "signedOut" });
    const operation = this.auth
      .signOut({ scope: "local" })
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (this.signOutOperation === operation) this.signOutOperation = null;
      });
    this.signOutOperation = operation;
    return operation;
  }

  getAccessToken(options?: TokenOptions): Promise<string | null> {
    if (!options?.forceRefresh)
      return Promise.resolve(this.session?.access_token ?? null);
    if (!this.session) return Promise.resolve(null);
    if (!this.refreshOperation) this.refreshOperation = this.refresh();
    return this.refreshOperation;
  }

  private async refresh(): Promise<string | null> {
    const context = this.beginOperation();
    try {
      const result = await this.auth.refreshSession();
      if (!this.canCommit(context)) return this.session?.access_token ?? null;
      if (result.error || !result.data.session) {
        await this.expireSession();
        return null;
      }
      this.session = result.data.session;
      this.setSnapshot({
        status: "signedIn",
        identityKey: this.session.user.id
      });
      return this.session.access_token;
    } catch {
      if (!this.canCommit(context)) return this.session?.access_token ?? null;
      await this.expireSession();
      return null;
    } finally {
      this.refreshOperation = null;
    }
  }

  private beginOperation(): OperationContext {
    return {
      generation: this.generation,
      authEventVersion: this.authEventVersion,
      operationEpoch: ++this.operationEpoch
    };
  }

  private canCommit(context: OperationContext): boolean {
    return (
      !this.disposed &&
      context.generation === this.generation &&
      context.authEventVersion === this.authEventVersion &&
      context.operationEpoch === this.operationEpoch
    );
  }

  private setSnapshot(snapshot: AuthSnapshot): void {
    if (snapshotsEqual(this.snapshot, snapshot)) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

export function createBrowserWebAuthClient(
  supabaseUrl: string,
  supabasePublishableKey: string,
  callbackUrl: string,
  storage: Storage = window.localStorage,
  factory: typeof createClient = createClient
): WebAuthClient {
  const client = factory(supabaseUrl, supabasePublishableKey, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: new ProviderTokenStrippingStorage(storage)
    }
  }) as SupabaseClient;
  return new WebAuthClient(client.auth, callbackUrl);
}
