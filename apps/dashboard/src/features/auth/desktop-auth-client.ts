import type { Platform } from "@/platform/contract";
import { loadingAuthSnapshot, type AccessGrant, type AuthClient, type AuthCompletionResult, type AuthSnapshot, type TokenOptions } from "./auth-client";
import type { DesktopAuthBridge } from "./desktop-bridge";
import { normalizeAuthEmail } from "./email";

const refreshWindowMs = 30_000;
const minimumRefreshBackoffMs = 1_000;
const maximumRefreshBackoffMs = 30_000;
let desktopIdentitySequence = 0;
function newDesktopIdentityKey(): string { return `desktop-session-${++desktopIdentitySequence}`; }

function commandError(error: unknown): Extract<AuthSnapshot, { status: "error" }> {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error &&
      typeof error.code === "string" && typeof error.message === "string") {
    return { status: "error", code: error.code, message: error.message };
  }
  return { status: "error", code: "auth_failed", message: "Authentication could not be completed." };
}

function callbackFlowId(input: string): string | null {
  try {
    decodeURI(input);
    const url = new URL(input);
    const flows = url.searchParams.getAll("sb_flow_id");
    return flows.length === 1 && /^[A-Za-z0-9_-]{1,128}$/u.test(flows[0]) ? flows[0] : null;
  } catch { return null; }
}

function isTerminalRefreshError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") return false;
  return new Set(["provider_rejected", "invalid_provider_response", "no_session"]).has(error.code);
}
function isUncertainExchangeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "provider_unavailable";
}

function snapshotsEqual(left: AuthSnapshot, right: AuthSnapshot): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "error" && right.status === "error") return left.code === right.code && left.message === right.message;
  if (left.status === "signedIn" && right.status === "signedIn") return left.identityKey === right.identityKey;
  if ((left.status === "sendingMagicLink" || left.status === "magicLinkSent") &&
      (right.status === "sendingMagicLink" || right.status === "magicLinkSent")) return left.email === right.email;
  return true;
}

export class DesktopAuthClient implements AuthClient {
  readonly capabilities = Object.freeze({ github: true, magicLink: true });
  private snapshot: AuthSnapshot = loadingAuthSnapshot;
  private grant: AccessGrant | null = null;
  private initialization: Promise<void> | null = null;
  private signInOperation: Promise<void> | null = null;
  private magicLinkOperation: Promise<void> | null = null;
  private refreshOperation: Promise<string | null> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly callbackOperations = new Map<string, Promise<AuthCompletionResult>>();
  private callbackGeneration: number | null = null;
  private uncorrelatedCallbackSequence = 0;
  private callbackCompleted = false;
  private callbackUnsubscribe: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshRetryAttempt = 0;
  private refreshRetryAtMs = 0;
  private transientRefreshError: unknown = null;
  private callbackPreservesWarmSession = false;
  private callbackExchangePending = false;
  private callbackExchangeError: unknown = null;
  private generation = 0;
  private identityKey: string | null = null;
  private disposed = false;

  constructor(private readonly platform: Platform, private readonly bridge: DesktopAuthBridge,
    private readonly now: () => number = Date.now) {}

  initialize(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.initialization) this.initialization = this.initializeOnce();
    return this.initialization;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.clearTimer();
    this.resetRefreshRetry();
    this.resetCallbackExchange();
    this.signInOperation = this.magicLinkOperation = null;
    this.refreshOperation = null;
    this.callbackOperations.clear();
    this.callbackGeneration = null;
    this.callbackCompleted = true;
    this.grant = null;
    this.identityKey = null;
    const unsubscribe = this.callbackUnsubscribe;
    this.callbackUnsubscribe = null;
    unsubscribe?.();
    this.listeners.clear();
  }

  private async initializeOnce(): Promise<void> {
    const generation = this.generation;
    try {
      const unsubscribe = await this.platform.onAuthCallback((url) => {
        if (!this.disposed) void this.completeSignIn(url.toString());
      });
      if (this.disposed) { unsubscribe(); return; }
      this.callbackUnsubscribe = unsubscribe;
      if (this.generation !== generation) return;
      const restored = await this.bridge.restore();
      if (!this.disposed && this.generation === generation && this.snapshot.status === "loading") {
        this.identityKey = restored ? newDesktopIdentityKey() : null;
        this.installGrant(restored);
        this.setSnapshot(restored ? { status: "signedIn", identityKey: this.identityKey as string } : { status: "signedOut" });
      }
    } catch (error) {
      if (!this.disposed && this.generation === generation && this.snapshot.status === "loading") this.setSnapshot(commandError(error));
    }
  }

  getSnapshot(): AuthSnapshot { return this.snapshot; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  signInWithGitHub(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.signInOperation) return this.signInOperation;
    if (this.magicLinkOperation) return this.magicLinkOperation;
    const generation = this.generation;
    this.callbackCompleted = false;
    this.callbackOperations.clear();
    this.callbackGeneration = null;
    this.setSnapshot({ status: "signingIn" });
    const operation = this.bridge.beginGitHub().catch((error) => {
      if (this.generation === generation) this.setSnapshot(commandError(error));
    }).finally(() => { if (this.signInOperation === operation) this.signInOperation = null; });
    this.signInOperation = operation;
    return operation;
  }

  sendMagicLink(value: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.magicLinkOperation) return this.magicLinkOperation;
    if (this.signInOperation) return this.signInOperation;
    const email = normalizeAuthEmail(value);
    if (!email) {
      this.setSnapshot({ status: "error", code: "invalid_email", message: "Enter a valid email address." });
      return Promise.resolve();
    }
    const generation = this.generation;
    this.callbackCompleted = false;
    this.callbackOperations.clear();
    this.callbackGeneration = null;
    this.setSnapshot({ status: "sendingMagicLink", email });
    const operation = this.bridge.sendMagicLink(email).then(() => {
      if (this.generation === generation) this.setSnapshot({ status: "magicLinkSent", email });
    }).catch((error) => {
      if (this.generation === generation) this.setSnapshot(commandError(error));
    }).finally(() => { if (this.magicLinkOperation === operation) this.magicLinkOperation = null; });
    this.magicLinkOperation = operation;
    return operation;
  }

  completeSignIn(callbackUrl: string): Promise<AuthCompletionResult> {
    if (this.disposed || this.callbackCompleted) return Promise.resolve({ status: "error" });
    const flow = callbackFlowId(callbackUrl);
    const key = flow === null ? `uncorrelated-${++this.uncorrelatedCallbackSequence}` : `flow-${flow}`;
    const existing = this.callbackOperations.get(key);
    if (existing) return existing;

    let generation = this.callbackGeneration;
    if (generation === null) {
      generation = ++this.generation;
      this.callbackGeneration = generation;
      this.callbackPreservesWarmSession = this.grant !== null && this.identityKey !== null;
      this.clearTimer();
      this.resetRefreshRetry();
      this.signInOperation = this.magicLinkOperation = null;
      this.refreshOperation = null;
      if (!this.callbackPreservesWarmSession) {
        this.grant = null;
        this.identityKey = null;
        this.setSnapshot({ status: "signingIn" });
      }
    }
    const operation = this.bridge.complete(callbackUrl).then((grant): AuthCompletionResult => {
      if (this.generation !== generation || this.callbackCompleted) return { status: "error" };
      this.identityKey = newDesktopIdentityKey();
      this.installGrant(grant);
      this.callbackCompleted = true;
      this.setSnapshot({ status: "signedIn", identityKey: this.identityKey });
      return { status: "success", identityKey: this.identityKey };
    }).catch((error): AuthCompletionResult => {
      const active = this.generation === generation && !this.callbackCompleted;
      if (active && isUncertainExchangeError(error)) {
        this.callbackExchangePending = true;
        this.callbackExchangeError = error;
      }
      if (active && this.callbackOperations.size === 1) {
        if (this.callbackExchangePending) {
          if (this.callbackPreservesWarmSession && this.grant && this.identityKey && this.grant.expiresAtMs > this.now()) {
            this.setSnapshot({ status: "signedIn", identityKey: this.identityKey });
          } else {
            this.setSnapshot(commandError(this.callbackExchangeError ?? error));
          }
        } else if (this.callbackPreservesWarmSession && this.grant && this.identityKey) {
          this.installGrant(this.grant);
          this.setSnapshot({ status: "signedIn", identityKey: this.identityKey });
        } else {
          this.setSnapshot(commandError(error));
        }
      }
      return { status: "error" };
    }).finally(() => {
      if (this.callbackOperations.get(key) === operation) this.callbackOperations.delete(key);
      if (this.callbackOperations.size === 0 && this.callbackGeneration === generation) {
        this.callbackGeneration = null;
        this.callbackPreservesWarmSession = false;
      }
    });
    this.callbackOperations.set(key, operation);
    return operation;
  }

  async signOut(): Promise<void> {
    const generation = ++this.generation;
    this.clearLocalSession();
    this.callbackCompleted = false;
    this.setSnapshot({ status: "signedOut" });
    try { await this.bridge.signOut(); }
    catch (error) { if (!this.disposed && this.generation === generation) this.setSnapshot(commandError(error)); }
  }

  async expireSession(): Promise<void> {
    const generation = ++this.generation;
    this.clearLocalSession();
    this.callbackCompleted = false;
    this.setSnapshot({ status: "signedOut" });
    try { await this.bridge.expire(); }
    catch (error) { if (!this.disposed && this.generation === generation) this.setSnapshot(commandError(error)); }
  }

  async getAccessToken(options?: TokenOptions): Promise<string | null> {
    const grant = this.grant;
    if (!grant) return null;
    const now = this.now();
    const forced = options?.forceRefresh === true;
    const refreshLocked = this.callbackExchangePending || this.callbackGeneration !== null || this.refreshRetryAtMs > now;
    if (grant.expiresAtMs <= now) {
      if (refreshLocked) {
        const error = this.callbackExchangeError ?? this.transientRefreshError;
        if (error !== null) this.setSnapshot(commandError(error));
        return null;
      }
      return this.refreshForCaller(grant, forced);
    }
    if (refreshLocked) return forced ? null : grant.accessToken;
    if (!forced && grant.expiresAtMs - now >= refreshWindowMs) return grant.accessToken;
    return this.refreshForCaller(grant, forced);
  }

  private async refreshForCaller(grant: AccessGrant, forced: boolean): Promise<string | null> {
    const token = await this.refreshCurrent(grant);
    if (forced && this.grant === grant &&
        (this.callbackExchangePending || this.refreshRetryAtMs > this.now())) return null;
    return token;
  }

  private refreshCurrent(grant: AccessGrant): Promise<string | null> {
    if (this.refreshOperation) return this.refreshOperation;
    const generation = this.generation;
    const operation = this.bridge.refresh().then((refreshed) => {
      if (this.generation !== generation || this.grant !== grant) return this.grant?.accessToken ?? null;
      this.installGrant(refreshed);
      if (this.identityKey) this.setSnapshot({ status: "signedIn", identityKey: this.identityKey });
      return refreshed.accessToken;
    }).catch(async (error) => {
      if (this.generation === generation && this.grant === grant) {
        if (isTerminalRefreshError(error)) {
          await this.expireSession();
        } else {
          this.scheduleTransientRefresh(grant, error);
          if (grant.expiresAtMs > this.now() && this.identityKey) {
            this.setSnapshot({ status: "signedIn", identityKey: this.identityKey });
            return grant.accessToken;
          }
          this.setSnapshot(commandError(error));
        }
      }
      return null;
    }).finally(() => { if (this.refreshOperation === operation) this.refreshOperation = null; });
    this.refreshOperation = operation;
    return operation;
  }

  private installGrant(grant: AccessGrant | null): void {
    this.clearTimer();
    this.resetRefreshRetry();
    this.resetCallbackExchange();
    this.grant = grant;
    if (!grant || this.disposed) return;
    const delay = Math.max(minimumRefreshBackoffMs,
      Math.min(2_147_483_647, grant.expiresAtMs - this.now() - refreshWindowMs));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (!this.disposed && this.grant === grant) void this.refreshCurrent(grant);
    }, delay);
  }

  private scheduleTransientRefresh(grant: AccessGrant, error: unknown): void {
    this.clearTimer();
    this.transientRefreshError = error;
    this.refreshRetryAttempt += 1;
    const delay = Math.min(maximumRefreshBackoffMs,
      minimumRefreshBackoffMs * (2 ** Math.min(this.refreshRetryAttempt - 1, 10)));
    this.refreshRetryAtMs = this.now() + delay;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (!this.disposed && this.grant === grant) void this.refreshCurrent(grant);
    }, delay);
  }

  private resetRefreshRetry(): void {
    this.refreshRetryAttempt = 0;
    this.refreshRetryAtMs = 0;
    this.transientRefreshError = null;
  }
  private resetCallbackExchange(): void {
    this.callbackExchangePending = false;
    this.callbackExchangeError = null;
  }
  private clearTimer(): void { if (this.refreshTimer !== null) clearTimeout(this.refreshTimer); this.refreshTimer = null; }
  private clearLocalSession(): void {
    this.clearTimer();
    this.resetRefreshRetry();
    this.resetCallbackExchange();
    this.signInOperation = this.magicLinkOperation = null;
    this.callbackOperations.clear();
    this.callbackGeneration = null;
    this.callbackPreservesWarmSession = false;
    this.refreshOperation = null;
    this.grant = null;
    this.identityKey = null;
  }
  private setSnapshot(snapshot: AuthSnapshot): void {
    if (snapshotsEqual(this.snapshot, snapshot)) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}
