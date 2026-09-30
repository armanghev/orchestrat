import type { McpServer } from "@modelcontextprotocol/server";
import {
  AgentApiError,
  type AgentApiClient,
  type Branch
} from "@orchestrat/sdk";
import { z } from "zod";
import type { ToolResult } from "./attention-tools.js";
import type { ClaimTokenStore } from "./index.js";

// Branches for the MCP bridge (docs/project-branches.md §7.2). The session is
// pinned to one branch; switching closes it and opens a new one. A failed
// close keeps the session, the claim tokens and the heartbeat, so nothing
// local is lost and the switch can simply be retried.

/** What the CLI reads from the Git checkout, override first. */
export type CheckoutBranch = {
  /** The branch to follow, or null for a detached HEAD. */
  name: string | null;
  /** The remote's default branch (`origin/HEAD`), when Git recorded it. */
  defaultBranch: string | null;
  headSha: string | null;
};

type BranchRef = Pick<Branch, "id" | "name" | "is_default">;
type SessionClient = Pick<AgentApiClient, "openSession" | "closeSession"> &
  Partial<Pick<AgentApiClient, "branches" | "withBranch" | "withSession">>;
export type BranchNotice = { type: string } & Record<string, unknown>;

export type BranchHost<C extends SessionClient> = {
  /** The project client without branch or session headers. */
  base(): C | undefined;
  /** The client tools use now (scoped to the branch and session). */
  client(): C | undefined;
  session(): string | undefined;
  /** Installs the client and session every later tool call uses. */
  adopt(client: C | undefined, sessionId: string | undefined): void;
  claims: ClaimTokenStore;
  openInput(): { runtime: string; integration: string };
  resolveCheckout?: () => Promise<CheckoutBranch | null>;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ref = (branch: BranchRef): BranchRef => ({
  id: branch.id,
  name: branch.name,
  is_default: branch.is_default
});

export class BranchController<C extends SessionClient> {
  private branch?: BranchRef;
  private branchId?: string;
  private following: boolean;
  // An API from before branches, or a client without branch methods.
  private unsupported = false;
  // The checkout branch the server refused as archived; we stay on the
  // default branch and say so on every call until the checkout changes.
  private archivedCheckout?: string;
  private detachedNoticeSent = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: BranchHost<C>) {
    this.following = Boolean(host.resolveCheckout);
  }

  private supported(
    client: C | undefined
  ): client is C &
    Required<Pick<AgentApiClient, "branches" | "withBranch" | "withSession">> {
    return (
      !this.unsupported &&
      typeof client?.withBranch === "function" &&
      typeof client.withSession === "function" &&
      client.branches !== undefined
    );
  }

  // Switches never interleave: two calls noticing the same checkout change
  // must not open two sessions.
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Opens the first session: on the checkout's branch when following. */
  async start() {
    await this.open(this.following ? await this.checkoutTarget() : null);
  }

  /** A newly selected project (global mode) starts on its default branch. */
  async reset() {
    this.branch = undefined;
    this.branchId = undefined;
    this.archivedCheckout = undefined;
    this.unsupported = false;
    await this.open(null);
  }

  private async open(target: BranchRef | null) {
    const base = this.host.base();
    if (!base) return;
    const branched = this.supported(base);
    // withBranch/withSession return full SDK clients; C is the slice we use.
    const scoped: C =
      target && branched ? (base.withBranch(target.id) as unknown as C) : base;
    const opened = await scoped.openSession(this.host.openInput());
    this.branch = target ?? undefined;
    this.branchId = target?.id ?? opened.session.branch_id ?? undefined;
    this.host.adopt(
      branched
        ? ((scoped as unknown as AgentApiClient).withSession(
            opened.session.id
          ) as unknown as C)
        : scoped,
      opened.session.id
    );
  }

  private async switchTo(target: BranchRef | null) {
    const sessionId = this.host.session();
    // If the close throws, the session, claims and heartbeat stay untouched.
    if (sessionId) await this.host.client()?.closeSession(sessionId);
    const released = this.host.claims.taskIds();
    this.host.claims.clear();
    this.host.adopt(this.host.base(), undefined);
    await this.open(target);
    return released;
  }

  private async register(
    checkout: CheckoutBranch
  ): Promise<BranchRef | "archived" | null> {
    const base = this.host.base();
    if (!checkout.name || !this.supported(base)) return null;
    const details = {
      ...(checkout.defaultBranch
        ? { git_default_branch: checkout.defaultBranch }
        : {}),
      ...(checkout.headSha ? { head_sha: checkout.headSha } : {})
    };
    for (const input of [
      { name: checkout.name, ...details },
      { name: checkout.name }
    ])
      try {
        return ref((await base.branches.register(input)).branch);
      } catch (error) {
        if (!(error instanceof AgentApiError)) continue;
        if (error.code === "BRANCH_ARCHIVED") return "archived";
        if (error.status === 404) this.unsupported = true;
        return null;
      }
    return null;
  }

  // An archived checkout branch works on the default branch; every call then
  // carries a branch_archived notice until the checkout or selection changes.
  private async checkoutTarget() {
    const checkout = await this.readCheckout();
    if (!checkout?.name) return null;
    const registered = await this.register(checkout);
    if (registered !== "archived") return registered;
    this.archivedCheckout = checkout.name;
    return null;
  }

  private readCheckout() {
    return (this.host.resolveCheckout?.() ?? Promise.resolve(null)).catch(
      () => null
    );
  }

  private archivedNotice(name: string): BranchNotice {
    return {
      type: "branch_archived",
      branch: name,
      working_on: "default",
      hint: "The checkout's branch is archived in Orchestrat. Call select_branch to choose a branch."
    };
  }

  /**
   * Before each tool call in follow mode: move the session to the checkout's
   * branch when nothing is claimed, or say why not.
   */
  follow(): Promise<BranchNotice[]> {
    if (!this.following || !this.host.resolveCheckout || !this.host.base())
      return Promise.resolve([]);
    return this.exclusive(async () => {
      const checkout = await this.readCheckout();
      if (!checkout) return this.ensureOpen([]);
      if (!checkout.name) {
        const notices: BranchNotice[] = this.detachedNoticeSent
          ? []
          : [
              {
                type: "checkout_detached",
                working_on: this.branch?.name ?? null
              }
            ];
        this.detachedNoticeSent = true;
        return this.ensureOpen(notices);
      }
      this.detachedNoticeSent = false;
      if (checkout.name === this.archivedCheckout)
        return this.ensureOpen([this.archivedNotice(checkout.name)]);
      this.archivedCheckout = undefined;
      const open = this.host.session() !== undefined;
      if (open && checkout.name === this.branch?.name) return [];
      const claims = this.host.claims.taskIds();
      if (open && claims.length)
        return [
          {
            type: "branch_mismatch",
            checkout: checkout.name,
            session: this.branch?.name ?? null,
            active_claims: claims
          }
        ];
      const registered = await this.register(checkout);
      if (registered === null) return this.ensureOpen([]);
      if (registered === "archived") {
        this.archivedCheckout = checkout.name;
        const onDefault = !this.branch || this.branch.is_default;
        if (open && onDefault) return [this.archivedNotice(checkout.name)];
        return this.switchWithNotice(null, checkout.name, [
          this.archivedNotice(checkout.name)
        ]);
      }
      if (registered.id === this.branchId && open) {
        this.branch = registered;
        return [];
      }
      return this.switchWithNotice(registered, checkout.name, [
        {
          type: "branch_switched",
          from: this.branch?.name ?? null,
          to: registered.name
        }
      ]);
    });
  }

  private async switchWithNotice(
    target: BranchRef | null,
    checkout: string,
    notices: BranchNotice[]
  ) {
    try {
      await this.switchTo(target);
      return notices;
    } catch (error) {
      return [
        {
          type: "branch_switch_failed",
          checkout,
          error: error instanceof AgentApiError ? error.code : "INTERNAL_ERROR"
        }
      ];
    }
  }

  // A session lost to a failed switch comes back on the next call.
  private async ensureOpen(notices: BranchNotice[]) {
    if (!this.host.session())
      await this.open(
        this.archivedCheckout ? null : (this.branch ?? null)
      ).catch(() => undefined);
    return notices;
  }

  /**
   * After a failed call: when the pinned branch was archived (the archive
   * closed the session), follow mode moves to the default branch; manual
   * mode says to call select_branch.
   */
  async afterError(error: unknown): Promise<BranchNotice[]> {
    const base = this.host.base();
    if (
      !(error instanceof AgentApiError) ||
      !["BRANCH_ARCHIVED", "AGENT_SESSION_CLOSED"].includes(error.code) ||
      !this.branchId ||
      !this.supported(base)
    )
      return [];
    return this.exclusive(async () => {
      const current = await base.branches
        .get(this.branchId!)
        .then(({ branch }) => branch)
        .catch(() => undefined);
      if (!current?.archived_at) return [];
      if (!this.following)
        return [
          {
            type: "branch_archived",
            branch: current.name,
            hint: "This branch was archived; call select_branch."
          }
        ];
      this.archivedCheckout = current.name;
      await this.switchTo(null).catch(() => undefined);
      return [this.archivedNotice(current.name)];
    });
  }

  /** The select_branch tool. */
  select(input: {
    branch?: string;
    follow_checkout?: boolean;
    create?: boolean;
  }) {
    const base = this.host.base();
    if (!base)
      throw new AgentApiError(
        409,
        "AGENT_SESSION_NOT_FOUND",
        "Select an Orchestrat project before using project tools."
      );
    if (!this.supported(base))
      throw new AgentApiError(
        404,
        "NOT_FOUND",
        "This Orchestrat API does not support branches yet."
      );
    if (Boolean(input.branch) === Boolean(input.follow_checkout))
      throw new AgentApiError(
        400,
        "VALIDATION_ERROR",
        "Pass either branch or follow_checkout: true."
      );
    if (input.follow_checkout && !this.host.resolveCheckout)
      throw new AgentApiError(
        400,
        "VALIDATION_ERROR",
        "Following the checkout needs a project-scoped connection."
      );
    return this.exclusive(async () => {
      let target: BranchRef | null;
      if (input.follow_checkout) {
        this.following = true;
        this.archivedCheckout = undefined;
        target = await this.checkoutTarget();
      } else {
        target = await this.find(base, input.branch!, input.create === true);
        this.following = false;
        this.archivedCheckout = undefined;
      }
      target ??= await this.defaultBranch(base);
      if (target.id === this.branchId && this.host.session())
        return {
          branch: target,
          released_claim_task_ids: [] as string[],
          follow_checkout: this.following
        };
      const released = await this.switchTo(target);
      return {
        branch: target,
        released_claim_task_ids: released,
        follow_checkout: this.following
      };
    });
  }

  private async find(
    base: C & Required<Pick<AgentApiClient, "branches">>,
    name: string,
    create: boolean
  ): Promise<BranchRef> {
    if (uuidPattern.test(name)) {
      const { branch } = await base.branches.get(name);
      if (branch.archived_at)
        throw new AgentApiError(
          409,
          "BRANCH_ARCHIVED",
          "This branch is archived.",
          {
            branch_id: branch.id
          }
        );
      return ref(branch);
    }
    const [found] = (await base.branches.list({ name })).branches;
    if (found) return ref(found);
    if (create) return ref((await base.branches.register({ name })).branch);
    throw new AgentApiError(
      404,
      "BRANCH_NOT_FOUND",
      `No active branch is named ${name}. Pass create: true to create it.`,
      { name }
    );
  }

  private async defaultBranch(
    base: C & Required<Pick<AgentApiClient, "branches">>
  ): Promise<BranchRef> {
    const found = (await base.branches.list()).branches.find(
      (branch) => branch.is_default
    );
    if (!found)
      throw new AgentApiError(404, "BRANCH_NOT_FOUND", "No default branch.");
    return ref(found);
  }

  /** Extra get_project fields; nothing for an API without branches. */
  async describe() {
    const base = this.host.base();
    if (!this.supported(base)) return {};
    if (!this.branch && this.branchId)
      this.branch = await base.branches
        .get(this.branchId)
        .then(({ branch }) => ref(branch))
        .catch(() => undefined);
    return { branch: this.branch ?? null, follow_checkout: this.following };
  }

  /** The list_branches tool. */
  async list(includeArchived: boolean) {
    const base = this.host.base();
    if (!this.supported(base))
      throw new AgentApiError(
        404,
        "NOT_FOUND",
        "This Orchestrat API does not support branches yet."
      );
    const { branches } = await base.branches.list({
      include_archived: includeArchived
    });
    return {
      branches: branches.map((branch) => ({
        ...branch,
        is_current: branch.id === this.branchId
      })),
      follow_checkout: this.following
    };
  }
}

export function registerBranchTools(host: {
  server: McpServer;
  call<T>(
    operation: () => Promise<T>,
    options?: { followCheckout?: boolean }
  ): Promise<ToolResult>;
  branches: Pick<BranchController<SessionClient>, "select" | "list">;
}) {
  host.server.registerTool(
    "list_branches",
    {
      description:
        "List the project's branches. is_current marks the branch this session works on; is_default marks the project's default.",
      inputSchema: { include_archived: z.boolean().optional() }
    },
    async ({ include_archived }) =>
      host.call(() => host.branches.list(include_archived === true))
  );
  host.server.registerTool(
    "select_branch",
    {
      description:
        "Move this session to another branch by id or name (create: true registers a missing one), or pass follow_checkout: true to follow the Git checkout again. Switching closes the session, which releases its claims; if the close fails, nothing changes and you can retry.",
      inputSchema: {
        branch: z.string().trim().min(1).max(255).optional(),
        follow_checkout: z.boolean().optional(),
        create: z.boolean().optional()
      }
    },
    async (input) =>
      host.call(() => host.branches.select(input), { followCheckout: false })
  );
}
