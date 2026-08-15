import type { Platform } from "@/platform/contract";
import { loadingAuthSnapshot, type AccessGrant, type AuthClient, type AuthCompletionResult, type AuthSnapshot, type TokenOptions } from "./auth-client";
import type { DesktopAuthBridge } from "./desktop-bridge";

const refreshWindowMs = 30_000;
const maximumEmailLength = 254;
let desktopIdentitySequence = 0;
function newDesktopIdentityKey(): string { return `desktop-session-${++desktopIdentitySequence}`; }

function commandError(error: unknown): Extract<AuthSnapshot, { status: "error" }> {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error &&
      typeof error.code === "string" && typeof error.message === "string") {
    return { status: "error", code: error.code, message: error.message };
  }
  return { status: "error", code: "auth_failed", message: "Authentication could not be completed." };
}

function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > maximumEmailLength || [...email].some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; }) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return null;
  return email;
}

function isTerminalRefreshError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") return false;
  return new Set(["provider_rejected", "invalid_provider_response", "no_session"]).has(error.code);
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
  private callbackOperation: Promise<AuthCompletionResult> | null = null;
  private callbackCompleted = false;
  private callbackUnsubscribe: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.signInOperation = this.magicLinkOperation = null;
    this.refreshOperation = null;
    this.callbackOperation = null;
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
    this.callbackOperation = null;
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
    const email = normalizeEmail(value);
    if (!email) {
      this.setSnapshot({ status: "error", code: "invalid_email", message: "Enter a valid email address." });
      return Promise.resolve();
    }
    const generation = this.generation;
    this.callbackCompleted = false;
    this.callbackOperation = null;
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
    if (this.callbackOperation) return this.callbackOperation;
    const generation = ++this.generation;
    this.clearTimer();
    this.grant = null;
    this.identityKey = null;
    this.signInOperation = this.magicLinkOperation = null;
    this.refreshOperation = null;
    this.setSnapshot({ status: "signingIn" });
    const operation = this.bridge.complete(callbackUrl).then((grant): AuthCompletionResult => {
      if (this.generation !== generation) return { status: "error" };
      this.identityKey = newDesktopIdentityKey();
      this.installGrant(grant);
      this.callbackCompleted = true;
      this.setSnapshot({ status: "signedIn", identityKey: this.identityKey });
      return { status: "success", identityKey: this.identityKey };
    }).catch((error): AuthCompletionResult => {
      if (this.generation === generation) this.setSnapshot(commandError(error));
      return { status: "error" };
    }).finally(() => { if (this.callbackOperation === operation) this.callbackOperation = null; });
    this.callbackOperation = operation;
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
    if (!options?.forceRefresh && grant.expiresAtMs - this.now() >= refreshWindowMs) return grant.accessToken;
    return this.refreshCurrent(grant);
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
        if (isTerminalRefreshError(error)) await this.expireSession();
        else {
          ++this.generation;
          this.clearLocalSession();
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
    this.grant = grant;
    if (!grant || this.disposed) return;
    const delay = Math.max(0, Math.min(2_147_483_647, grant.expiresAtMs - this.now() - refreshWindowMs));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (!this.disposed && this.grant === grant) void this.refreshCurrent(grant);
    }, delay);
  }

  private clearTimer(): void { if (this.refreshTimer !== null) clearTimeout(this.refreshTimer); this.refreshTimer = null; }
  private clearLocalSession(): void {
    this.clearTimer();
    this.signInOperation = this.magicLinkOperation = null;
    this.callbackOperation = null;
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
