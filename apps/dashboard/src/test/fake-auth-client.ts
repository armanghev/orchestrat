import { vi } from "vitest";
import type {
  AuthClient,
  AuthInstance,
  AuthSnapshot
} from "@/features/auth/auth-client";

/**
 * A controllable AuthClient for route and component tests. Methods are spies
 * that do nothing by default; `emit` changes the snapshot.
 */
export class FakeAuthClient implements AuthClient {
  private readonly listeners = new Set<() => void>();

  constructor(
    private snapshot: AuthSnapshot,
    private instance: AuthInstance = {
      needs_setup: false,
      signup_mode: "invite"
    }
  ) {}

  initialize = vi.fn<AuthClient["initialize"]>(async () => undefined);
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getInstance = vi.fn<AuthClient["getInstance"]>(async () => this.instance);
  signIn = vi.fn<AuthClient["signIn"]>(async () => undefined);
  signUp = vi.fn<AuthClient["signUp"]>(async () => ({
    invitedProjectId: null
  }));
  signOut = vi.fn<AuthClient["signOut"]>(async () => undefined);
  signOutEverywhere = vi.fn<AuthClient["signOutEverywhere"]>(
    async () => undefined
  );
  changePassword = vi.fn<AuthClient["changePassword"]>(async () => undefined);
  expireSession = vi.fn<AuthClient["expireSession"]>(async () => undefined);
  getAccessToken = vi.fn<AuthClient["getAccessToken"]>(async () =>
    this.snapshot.status === "signedIn" ? "test-token" : null
  );

  emit(snapshot: AuthSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }

  setInstance(instance: AuthInstance): void {
    this.instance = instance;
  }
}

export const signedIn = (identityKey = "user"): AuthSnapshot => ({
  status: "signedIn",
  identityKey
});
export const signedOut: AuthSnapshot = { status: "signedOut" };
