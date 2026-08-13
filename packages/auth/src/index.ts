import { createClerkClient } from "@clerk/backend";

export type AuthRequest = {
  headers: HeadersInit;
  method: string;
  url: string;
};

export type HumanProfile = {
  authSubject: string;
  avatarUrl: string | null;
  email: string;
  name: string;
};

export type HumanAuth = {
  authenticate(request: AuthRequest): Promise<string | null>;
  getProfile(authSubject: string): Promise<HumanProfile>;
};

export function createClerkAuth(options: {
  authorizedParties: string[];
  publishableKey: string;
  secretKey: string;
}): HumanAuth {
  const clerk = createClerkClient({
    publishableKey: options.publishableKey,
    secretKey: options.secretKey
  });

  return {
    async authenticate(request) {
      const state = await clerk.authenticateRequest(
        new Request(request.url, {
          headers: request.headers,
          method: request.method
        }),
        {
          acceptsToken: "session_token",
          authorizedParties: options.authorizedParties
        }
      );
      if (!state.isAuthenticated) return null;
      return state.toAuth().userId;
    },

    async getProfile(authSubject) {
      const user = await clerk.users.getUser(authSubject);
      const email = user.emailAddresses.find(
        (item) => item.id === user.primaryEmailAddressId
      )?.emailAddress;
      if (!email) throw new Error("The Clerk user has no primary email address.");

      return {
        authSubject,
        avatarUrl: user.imageUrl || null,
        email: email.trim().toLowerCase(),
        name:
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          user.username ||
          email.split("@")[0]
      };
    }
  };
}
