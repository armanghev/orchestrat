import { randomUUID } from "node:crypto";

// The GitLab.com endpoints the adapter uses, in memory, behind an injected
// fetch (docs/project-branches.md §13.3). Access tokens expire on the shared
// clock and refresh tokens rotate, like GitLab's.

type Project = {
  id: number;
  path_with_namespace: string;
  default_branch: string;
  branches: Map<string, string>;
  members: Map<number, number>;
  mergeRequests: Record<string, unknown>[];
  hooks: Map<
    number,
    {
      body: Record<string, unknown>;
      alert_status: string;
      disabled_until: string | null;
    }
  >;
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

export class FakeGitLab {
  readonly projects = new Map<number, Project>();
  readonly codes = new Map<string, number>();
  readonly access = new Map<string, { user: number; expiresAt: number }>();
  readonly refresh = new Map<string, number>();
  readonly revoked: string[] = [];
  readonly tested: number[] = [];
  refreshes = 0;
  clientId = "gitlab-client";
  clientSecret = "gitlab-secret";
  applicationUid = "gitlab-client";

  constructor(private readonly now: () => Date) {}

  private pair(user: number) {
    const access = `glpat-${randomUUID()}`;
    const refresh = `glrt-${randomUUID()}`;
    this.access.set(access, {
      user,
      expiresAt: this.now().getTime() + 7200_000
    });
    this.refresh.set(refresh, user);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 7200,
      created_at: Math.floor(this.now().getTime() / 1000)
    };
  }

  /** A person, signed in with the code `code-<id>`. */
  user(id: number) {
    this.codes.set(`code-${id}`, id);
    return `code-${id}`;
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const token = (
      new Headers(init?.headers).get("authorization") ?? ""
    ).replace(/^Bearer /, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const path = url.pathname;
    const caller = this.access.get(token);
    const authorized = caller && caller.expiresAt > this.now().getTime();

    if (path === "/oauth/token" && method === "POST") {
      if (
        body.client_id !== this.clientId ||
        body.client_secret !== this.clientSecret
      )
        return reply(401, { error: "invalid_client" });
      if (body.grant_type === "authorization_code") {
        const user = this.codes.get(body.code);
        if (!user || !body.code_verifier)
          return reply(400, { error: "invalid_grant" });
        this.codes.delete(body.code);
        return reply(200, this.pair(user));
      }
      const user = this.refresh.get(body.refresh_token);
      if (user === undefined) return reply(400, { error: "invalid_grant" });
      // Rotation: the old refresh token stops working.
      this.refresh.delete(body.refresh_token);
      this.refreshes += 1;
      return reply(200, this.pair(user));
    }
    if (path === "/oauth/revoke") {
      this.revoked.push(body.token);
      return reply(200, {});
    }
    if (path === "/oauth/token/info")
      return authorized
        ? reply(200, { application: { uid: this.applicationUid } })
        : reply(401);
    if (!authorized) return reply(401);
    if (path === "/api/v4/user")
      return reply(200, { id: caller.user, username: `user${caller.user}` });
    if (path === "/api/v4/projects")
      return reply(
        200,
        [...this.projects.values()]
          .filter((project) => (project.members.get(caller.user) ?? 0) >= 40)
          .map(({ id, path_with_namespace, default_branch }) => ({
            id,
            path_with_namespace,
            default_branch
          }))
      );
    const match = path.match(/^\/api\/v4\/projects\/(\d+)(\/.*)?$/);
    if (!match) return reply(404);
    const project = this.projects.get(Number(match[1]));
    if (!project || !project.members.has(caller.user)) return reply(404);
    const rest = match[2] ?? "";
    const page = Number(url.searchParams.get("page") ?? "1");
    const paged = <T>(items: T[]) =>
      reply(
        200,
        items.slice((page - 1) * PAGE, page * PAGE),
        items.length > page * PAGE ? { "x-next-page": String(page + 1) } : {}
      );
    if (!rest)
      return reply(200, {
        id: project.id,
        path_with_namespace: project.path_with_namespace,
        web_url: `https://gitlab.com/${project.path_with_namespace}`,
        default_branch: project.default_branch
      });
    const member = rest.match(/^\/members\/all\/(\d+)$/);
    if (member) {
      const level = project.members.get(Number(member[1]));
      return level === undefined
        ? reply(404)
        : reply(200, { access_level: level });
    }
    if (rest === "/hooks" && method === "POST") {
      const id = project.hooks.size + 1;
      project.hooks.set(id, {
        body,
        alert_status: "executable",
        disabled_until: null
      });
      return reply(201, { id });
    }
    const hook = rest.match(/^\/hooks\/(\d+)(\/test\/push_events)?$/);
    if (hook) {
      const found = project.hooks.get(Number(hook[1]));
      if (!found) return reply(404);
      if (method === "DELETE") {
        project.hooks.delete(Number(hook[1]));
        return reply(204);
      }
      if (hook[2]) {
        this.tested.push(Number(hook[1]));
        found.alert_status = "executable";
        found.disabled_until = null;
        return reply(201, {});
      }
      return reply(200, {
        id: Number(hook[1]),
        alert_status: found.alert_status,
        disabled_until: found.disabled_until
      });
    }
    if (rest === "/repository/branches")
      return paged(
        [...project.branches].map(([name, sha]) => ({
          name,
          commit: { id: sha }
        }))
      );
    const branch = rest.match(/^\/repository\/branches\/(.+)$/);
    if (branch) {
      const name = decodeURIComponent(branch[1]!);
      const sha = project.branches.get(name);
      return sha === undefined
        ? reply(404)
        : reply(200, { name, commit: { id: sha } });
    }
    if (rest === "/merge_requests") {
      const after = url.searchParams.get("merged_after");
      return paged(
        project.mergeRequests.filter(
          (request) => !after || String(request.merged_at) >= after
        )
      );
    }
    return reply(404);
  };
}
