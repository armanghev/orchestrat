import { randomUUID } from "node:crypto";

// The GitHub REST endpoints the adapter uses, in memory, behind an injected
// fetch (docs/project-branches.md §13.3). Pages hold two items so pagination
// is exercised.

type Repository = {
  id: number;
  full_name: string;
  default_branch: string;
  branches: Map<string, string>;
  pulls: Record<string, unknown>[];
};

const PAGE = 2;
const reply = (
  status: number,
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });

export class FakeGitHub {
  readonly users = new Map<string, { id: number; installations: number[] }>();
  readonly installations = new Map<
    number,
    { suspended: boolean; repositories: number[] }
  >();
  readonly repositories = new Map<number, Repository>();
  readonly codes = new Map<string, string>();
  readonly minted: { installation: string; body: Record<string, unknown> }[] =
    [];
  readonly deliveries: {
    id: number;
    guid: string;
    status_code: number;
    delivered_at: string;
  }[] = [];
  readonly redelivered: number[] = [];
  /** Delivery ids GitHub answers 404 for when asked to redeliver. */
  readonly unredeliverable = new Set<number>();
  readonly installationTokens = new Map<string, number>();
  clientSecret = "github-client-secret";

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const path = url.pathname;
    const page = Number(url.searchParams.get("page") ?? "1");
    const paged = <T>(items: T[]) => {
      const slice = items.slice((page - 1) * PAGE, page * PAGE);
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      return reply(
        200,
        slice,
        items.length > page * PAGE ? { link: `<${next}>; rel="next"` } : {}
      );
    };

    if (url.host === "github.com" && path === "/login/oauth/access_token") {
      const user = this.codes.get(body.code);
      if (
        !user ||
        body.client_secret !== this.clientSecret ||
        !body.code_verifier
      )
        return reply(200, { error: "bad_verification_code" });
      return reply(200, { access_token: user });
    }
    if (path === "/user") {
      const user = this.users.get(token);
      return user ? reply(200, { id: user.id }) : reply(401);
    }
    if (path === "/user/installations") {
      const user = this.users.get(token);
      if (!user) return reply(401);
      return reply(200, {
        installations: user.installations.map((id) => ({ id }))
      });
    }
    let match = path.match(/^\/user\/installations\/(\d+)\/repositories$/);
    if (match) {
      const user = this.users.get(token);
      const id = Number(match[1]);
      if (!user?.installations.includes(id)) return reply(404);
      const repositories = this.installations
        .get(id)!
        .repositories.map((repo) => this.repositories.get(repo)!)
        .map(({ id: repo, full_name, default_branch }) => ({
          id: repo,
          full_name,
          default_branch
        }));
      return reply(200, { repositories });
    }
    match = path.match(/^\/app\/installations\/(\d+)$/);
    if (match) {
      const installation = this.installations.get(Number(match[1]));
      if (!installation || token.split(".").length !== 3) return reply(404);
      return reply(200, {
        id: Number(match[1]),
        suspended_at: installation.suspended ? "2026-09-01T00:00:00Z" : null
      });
    }
    match = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (match && method === "POST") {
      const installation = this.installations.get(Number(match[1]));
      if (!installation) return reply(404);
      if (installation.suspended) return reply(403);
      this.minted.push({ installation: match[1]!, body });
      const minted = `ghs_${randomUUID()}`;
      this.installationTokens.set(minted, Number(match[1]));
      return reply(201, { token: minted, expires_at: "2026-10-01T01:00:00Z" });
    }
    if (path === "/app/hook/deliveries") return paged(this.deliveries);
    match = path.match(/^\/app\/hook\/deliveries\/(\d+)\/attempts$/);
    if (match && method === "POST") {
      if (this.unredeliverable.has(Number(match[1]))) return reply(404, {});
      this.redelivered.push(Number(match[1]));
      return reply(202, {});
    }
    match = path.match(/^\/repositories\/(\d+)(\/.*)?$/);
    if (match) {
      const repository = this.repositories.get(Number(match[1]));
      const installation = this.installationTokens.get(token);
      if (
        !repository ||
        installation === undefined ||
        !this.installations
          .get(installation)
          ?.repositories.includes(repository.id)
      )
        return reply(404);
      const rest = match[2] ?? "";
      if (!rest)
        return reply(200, {
          id: repository.id,
          full_name: repository.full_name,
          html_url: `https://github.com/${repository.full_name}`,
          default_branch: repository.default_branch
        });
      if (rest === "/branches")
        return paged(
          [...repository.branches].map(([name, sha]) => ({
            name,
            commit: { sha }
          }))
        );
      const branch = rest.match(/^\/branches\/(.+)$/);
      if (branch) {
        const name = decodeURIComponent(branch[1]!);
        const sha = repository.branches.get(name);
        return sha === undefined
          ? reply(404)
          : reply(200, { name, commit: { sha } });
      }
      if (rest === "/pulls") return paged(repository.pulls);
    }
    return reply(404);
  };

  /** A person who authorized the app and can see some installations. */
  user(id: number, installations: number[]) {
    const token = `gho_${randomUUID()}`;
    const code = `code-${id}`;
    this.users.set(token, { id, installations });
    this.codes.set(code, token);
    return { token, code };
  }
}
