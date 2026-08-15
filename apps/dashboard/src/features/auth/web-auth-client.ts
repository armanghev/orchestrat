import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { type AuthCapabilities, type AuthClient, type AuthSnapshot, loadingAuthSnapshot, type TokenOptions } from "./auth-client";
import { ProviderTokenStrippingStorage } from "./web-auth-storage";

type AuthResult<T> = Promise<{ data: T; error: unknown }>;

export type WebAuthApi = {
  onAuthStateChange(listener: (event: AuthChangeEvent, session: Session | null) => void): {
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
  exchangeCodeForSession(code: string): AuthResult<{ session: Session | null; user: unknown }>;
  refreshSession(): AuthResult<{ session: Session | null; user: unknown }>;
  signOut(options: { scope: "local" }): Promise<{ error: unknown }>;
};

const webCapabilities: AuthCapabilities = Object.freeze({ github: true, magicLink: true });
const invalidCallbackError: AuthSnapshot = {
  status: "error", code: "invalid_callback", message: "We couldn't complete your sign-in. Try again."
};
const providerCallbackError: AuthSnapshot = {
  status: "error", code: "provider_error", message: "We couldn't complete your sign-in. Try again."
};

type ParsedCallback = { kind: "code"; code: string } | { kind: "providerError" } | { kind: "invalid" };

function snapshotsEqual(left: AuthSnapshot, right: AuthSnapshot): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "error" && right.status === "error") return left.code === right.code && left.message === right.message;
  if ((left.status === "sendingMagicLink" || left.status === "magicLinkSent") &&
      (right.status === "sendingMagicLink" || right.status === "magicLinkSent")) return left.email === right.email;
  return true;
}

function normalizedEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

function safeCallbackValue(value: string, maxLength: number): boolean {
  if (value.length === 0 || value.length > maxLength) return false;
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });
}

function parseCallback(callbackUrl: string, configuredCallbackUrl: string): ParsedCallback {
  let callback: URL;
  let configured: URL;
  try {
    callback = new URL(callbackUrl);
    configured = new URL(configuredCallbackUrl);
  } catch { return { kind: "invalid" }; }
  if (callback.origin !== configured.origin || callback.pathname !== configured.pathname ||
      callback.username || callback.password || callback.hash) return { kind: "invalid" };

  const allowed = new Set(["code", "error", "error_code", "error_description"]);
  const counts = new Map<string, number>();
  for (const [key] of callback.searchParams) {
    if (!allowed.has(key)) return { kind: "invalid" };
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if ([...counts.values()].some((count) => count !== 1)) return { kind: "invalid" };

  const code = callback.searchParams.get("code");
  const error = callback.searchParams.get("error");
  const errorCode = callback.searchParams.get("error_code");
  const errorDescription = callback.searchParams.get("error_description");
  if (code !== null) {
    if (error !== null || errorCode !== null || errorDescription !== null || !safeCallbackValue(code, 4096)) return { kind: "invalid" };
    return { kind: "code", code };
  }
  if (error !== null) {
    if (!safeCallbackValue(error, 256) ||
        (errorCode !== null && !safeCallbackValue(errorCode, 256)) ||
        (errorDescription !== null && !safeCallbackValue(errorDescription, 1024))) return { kind: "invalid" };
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
  private callbackOperation: Promise<void> | null = null;
  private callbackCompleted = false;
  private refreshOperation: Promise<string | null> | null = null;
  private signOutOperation: Promise<void> | null = null;
  private authUnsubscribe: (() => void) | null = null;
  private generation = 0;
  private authEventVersion = 0;
  private disposed = false;

  constructor(private readonly auth: WebAuthApi, private readonly callbackUrl: string) {}

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
        this.session = null;
        this.setSnapshot({ status: "signedOut" });
      } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        this.authEventVersion += 1;
        this.session = session;
        this.setSnapshot(session ? { status: "signedIn" } : { status: "signedOut" });
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
      if (!this.disposed && generation === this.generation && version === this.authEventVersion) {
        this.session = result.data.session;
        this.setSnapshot(this.session ? { status: "signedIn" } : { status: "signedOut" });
      }
    } catch {
      if (!this.disposed && generation === this.generation && this.snapshot.status === "loading") {
        this.setSnapshot({ status: "error", code: "session_restore_failed", message: "Your session could not be restored. Try again." });
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.session = null;
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    this.listeners.clear();
  }

  getSnapshot(): AuthSnapshot { return this.snapshot; }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  signInWithGitHub(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.githubOperation) return this.githubOperation;
    const generation = this.generation;
    this.callbackCompleted = false;
    this.setSnapshot({ status: "signingIn" });
    const operation = this.auth.signInWithOAuth({ provider: "github", options: { redirectTo: this.callbackUrl } })
      .then((result) => {
        if (result.error) throw result.error;
      })
      .catch(() => {
        if (!this.disposed && generation === this.generation) {
          this.setSnapshot({ status: "error", code: "oauth_start_failed", message: "Sign-in could not be started. Try again." });
        }
      })
      .finally(() => { if (this.githubOperation === operation) this.githubOperation = null; });
    this.githubOperation = operation;
    return operation;
  }

  sendMagicLink(value: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.magicLinkOperation) return this.magicLinkOperation;
    const email = normalizedEmail(value);
    if (!email) {
      this.setSnapshot({ status: "error", code: "invalid_email", message: "Enter a valid email address." });
      return Promise.resolve();
    }
    const generation = this.generation;
    this.setSnapshot({ status: "sendingMagicLink", email });
    const operation = this.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: this.callbackUrl, shouldCreateUser: true }
    }).then((result) => {
      if (result.error) throw result.error;
      if (!this.disposed && generation === this.generation) this.setSnapshot({ status: "magicLinkSent", email });
    }).catch(() => {
      if (!this.disposed && generation === this.generation) {
        this.setSnapshot({ status: "error", code: "magic_link_failed", message: "The sign-in link could not be sent. Try again." });
      }
    }).finally(() => { if (this.magicLinkOperation === operation) this.magicLinkOperation = null; });
    this.magicLinkOperation = operation;
    return operation;
  }

  completeSignIn(callbackUrl: string): Promise<void> {
    if (this.disposed || this.callbackCompleted) return Promise.resolve();
    if (this.callbackOperation) return this.callbackOperation;
    const parsed = parseCallback(callbackUrl, this.callbackUrl);
    if (parsed.kind === "invalid") {
      this.setSnapshot(invalidCallbackError);
      return Promise.resolve();
    }
    if (parsed.kind === "providerError") {
      this.setSnapshot(providerCallbackError);
      return Promise.resolve();
    }
    const generation = this.generation;
    this.setSnapshot({ status: "signingIn" });
    const operation = this.auth.exchangeCodeForSession(parsed.code).then((result) => {
      if (result.error || !result.data.session) throw result.error ?? new Error("Session missing");
      if (!this.disposed && generation === this.generation) {
        this.session = result.data.session;
        this.callbackCompleted = true;
        this.setSnapshot({ status: "signedIn" });
      }
    }).catch(() => {
      if (!this.disposed && generation === this.generation) {
        this.setSnapshot({ status: "error", code: "callback_exchange_failed", message: "We couldn't complete your sign-in. Try again." });
      }
    }).finally(() => { if (this.callbackOperation === operation) this.callbackOperation = null; });
    this.callbackOperation = operation;
    return operation;
  }

  signOut(): Promise<void> { return this.clearLocalSession(); }
  expireSession(): Promise<void> { return this.clearLocalSession(); }

  private clearLocalSession(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.signOutOperation) return this.signOutOperation;
    this.generation += 1;
    this.session = null;
    this.githubOperation = null;
    this.magicLinkOperation = null;
    this.callbackOperation = null;
    this.callbackCompleted = false;
    this.setSnapshot({ status: "signedOut" });
    const operation = this.auth.signOut({ scope: "local" })
      .then(() => undefined, () => undefined)
      .finally(() => { if (this.signOutOperation === operation) this.signOutOperation = null; });
    this.signOutOperation = operation;
    return operation;
  }

  getAccessToken(options?: TokenOptions): Promise<string | null> {
    if (!options?.forceRefresh) return Promise.resolve(this.session?.access_token ?? null);
    if (!this.session) return Promise.resolve(null);
    if (!this.refreshOperation) this.refreshOperation = this.refresh();
    return this.refreshOperation;
  }

  private async refresh(): Promise<string | null> {
    const generation = this.generation;
    try {
      const result = await this.auth.refreshSession();
      if (result.error || !result.data.session) throw result.error ?? new Error("Session missing");
      if (this.disposed || generation !== this.generation) return this.session?.access_token ?? null;
      this.session = result.data.session;
      this.setSnapshot({ status: "signedIn" });
      return this.session.access_token;
    } catch {
      if (!this.disposed && generation === this.generation) await this.expireSession();
      return null;
    } finally {
      this.refreshOperation = null;
    }
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
  return new WebAuthClient(client.auth as unknown as WebAuthApi, callbackUrl);
}
