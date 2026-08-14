import type { Platform } from "@/platform/contract";
import { loadingAuthSnapshot, type AccessGrant, type AuthClient, type AuthSnapshot, type TokenOptions } from "./auth-client";
import type { DesktopAuthBridge } from "./desktop-bridge";

const refreshWindowMs = 30_000;
function commandError(error: unknown): Extract<AuthSnapshot, { status: "error" }> {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    return { status: "error", code: error.code, message: error.message };
  }
  return { status: "error", code: "auth_failed", message: "Authentication could not be completed." };
}

function snapshotsEqual(left: AuthSnapshot, right: AuthSnapshot): boolean {
  return left.status === right.status &&
    (left.status !== "error" || right.status !== "error" ||
      (left.code === right.code && left.message === right.message));
}

export class DesktopAuthClient implements AuthClient {
  private snapshot: AuthSnapshot = loadingAuthSnapshot;
  private grant: AccessGrant | null = null;
  private initialization: Promise<void> | null = null;
  private signInOperation: Promise<void> | null = null;
  private refreshOperation: Promise<string | null> | null = null;
  private readonly listeners = new Set<() => void>();
  private callbackOperation: Promise<void> | null = null;
  private callbackCompleted = false;
  private callbackUnsubscribe: (() => void) | null = null;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly platform: Platform,
    private readonly bridge: DesktopAuthBridge,
    private readonly now: () => number = Date.now
  ) {}

  initialize(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.initialization) this.initialization = this.initializeOnce();
    return this.initialization;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.signInOperation = null;
    this.callbackOperation = null;
    this.callbackCompleted = true;
    const unsubscribe = this.callbackUnsubscribe;
    this.callbackUnsubscribe = null;
    unsubscribe?.();
    this.listeners.clear();
  }

  private async initializeOnce(): Promise<void> {
    const generation = this.generation;
    try {
      const unsubscribe = await this.platform.onAuthCallback((url) => {
        if (this.disposed || this.generation !== generation) return;
        void this.completeSignIn(url.toString());
      });
      if (this.disposed || this.generation !== generation) {
        unsubscribe();
        return;
      }
      this.callbackUnsubscribe = unsubscribe;
      const restored = await this.bridge.restore();
      if (!this.disposed && this.generation === generation && this.snapshot.status === "loading") {
        this.grant = restored;
        this.setSnapshot(restored ? { status: "signedIn" } : { status: "signedOut" });
      }
    } catch (error) {
      if (!this.disposed && this.generation === generation && this.snapshot.status === "loading") {
        this.setSnapshot(commandError(error));
      }
    }
  }

  getSnapshot(): AuthSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async signIn(): Promise<void> {
    if (this.disposed) return;
    if (this.signInOperation) return this.signInOperation;
    const generation = this.generation;
    this.callbackCompleted = false;
    this.callbackOperation = null;
    this.setSnapshot({ status: "signingIn" });
    const operation = this.bridge.begin()
      .catch((error) => {
        if (this.generation === generation) this.setSnapshot(commandError(error));
      })
      .finally(() => {
        if (this.signInOperation === operation) this.signInOperation = null;
      });
    this.signInOperation = operation;
    return operation;
  }

  completeSignIn(callbackUrl: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.completeCallback(callbackUrl);
  }

  private completeCallback(callbackUrl: string): Promise<void> {
    if (this.callbackCompleted) return Promise.resolve();
    if (this.callbackOperation) return this.callbackOperation;
    const generation = this.generation;
    const operation = this.bridge.complete(callbackUrl)
      .then((grant) => {
        if (this.generation !== generation) return;
        this.grant = grant;
        this.callbackCompleted = true;
        this.setSnapshot({ status: "signedIn" });
      })
      .catch((error) => {
        if (this.generation === generation) this.setSnapshot(commandError(error));
      })
      .finally(() => {
        if (this.callbackOperation === operation) this.callbackOperation = null;
      });
    this.callbackOperation = operation;
    return operation;
  }

  async signOut(): Promise<void> {
    const generation = ++this.generation;
    this.signInOperation = null;
    this.callbackOperation = null;
    this.grant = null;
    this.setSnapshot({ status: "signedOut" });
    try {
      await this.bridge.signOut();
    } catch (error) {
      if (this.generation === generation) this.setSnapshot(commandError(error));
    }
  }

  async expireSession(): Promise<void> {
    this.generation += 1;
    this.signInOperation = null;
    this.callbackOperation = null;
    this.grant = null;
    this.setSnapshot({ status: "signedOut" });
  }

  async getAccessToken(options?: TokenOptions): Promise<string | null> {
    const grant = this.grant;
    if (!grant) return null;
    if (!options?.forceRefresh && grant.expiresAtMs - this.now() >= refreshWindowMs) {
      return grant.accessToken;
    }
    if (!this.refreshOperation) this.refreshOperation = this.refresh(grant);
    return this.refreshOperation;
  }

  private async refresh(grant: AccessGrant): Promise<string | null> {
    const generation = this.generation;
    try {
      const refreshed = await this.bridge.refresh();
      if (this.generation !== generation || this.grant !== grant) return this.grant?.accessToken ?? null;
      this.grant = refreshed;
      this.setSnapshot({ status: "signedIn" });
      return refreshed.accessToken;
    } catch {
      if (this.generation === generation && this.grant === grant) await this.expireSession();
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
