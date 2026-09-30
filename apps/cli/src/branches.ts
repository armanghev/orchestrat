import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CheckoutBranch } from "@orchestrat/mcp";
import {
  AgentApiError,
  type AgentApiClient,
  type Branch
} from "@orchestrat/sdk";
import {
  detectCheckout,
  nodeGitReader,
  type Checkout,
  type GitReader
} from "./git.js";
import { readPrivateState, writePrivateState } from "./safe-files.js";

// Which Orchestrat branch a checkout works on (docs/project-branches.md §7.3):
// the per-checkout override from `orchestrat branch select`, else the branch
// Git has checked out, else the project's default branch.

export const branchOverridesPath = (home: string) =>
  join(home, ".orchestrat", "branch-overrides.json");

// A file of its own, so config.json and its version stay untouched.
type Overrides = { version: 1; checkouts: Record<string, { branch: string }> };

async function readOverrides(home: string): Promise<Overrides> {
  try {
    const value = JSON.parse(
      (await readPrivateState(branchOverridesPath(home), 64 * 1024)) ?? ""
    ) as Overrides;
    if (value?.version !== 1 || !value.checkouts) throw new Error("invalid");
    const checkouts: Overrides["checkouts"] = {};
    for (const [root, entry] of Object.entries(value.checkouts))
      if (typeof entry?.branch === "string" && entry.branch)
        checkouts[root] = { branch: entry.branch };
    return { version: 1, checkouts };
  } catch {
    return { version: 1, checkouts: {} };
  }
}

const checkoutKey = (repoRoot: string) =>
  realpath(repoRoot).catch(() => repoRoot);

export async function setBranchOverride(
  home: string,
  repoRoot: string,
  branch: string | null
) {
  const overrides = await readOverrides(home);
  const key = await checkoutKey(repoRoot);
  if (branch) overrides.checkouts[key] = { branch };
  else delete overrides.checkouts[key];
  await writePrivateState(
    branchOverridesPath(home),
    `${JSON.stringify(overrides, null, 2)}\n`
  );
}

export type CheckoutTarget = {
  checkout: Checkout | null;
  /** The branch to work on, or null for the project's default branch. */
  name: string | null;
  overridden: boolean;
};

export async function checkoutTarget(
  cwd: string,
  home: string,
  reader: GitReader = nodeGitReader
): Promise<CheckoutTarget> {
  const checkout = await detectCheckout(cwd, reader);
  if (!checkout) return { checkout: null, name: null, overridden: false };
  const override = (await readOverrides(home)).checkouts[
    await checkoutKey(checkout.repoRoot)
  ]?.branch;
  return override
    ? { checkout, name: override, overridden: true }
    : { checkout, name: checkout.branch, overridden: false };
}

/**
 * The MCP bridge asks before every tool call which branch the checkout is on.
 * This re-reads the checkout only when HEAD or the overrides file changed.
 */
export function checkoutResolver(
  cwd: string,
  home: string,
  reader: GitReader = nodeGitReader
) {
  let cache:
    { stamp: string; headPath: string; value: CheckoutBranch } | undefined;
  const stampOf = async (headPath: string) =>
    (
      await Promise.all(
        [headPath, branchOverridesPath(home)].map((path) =>
          stat(path).then(
            (info) => info.mtimeMs,
            () => 0
          )
        )
      )
    ).join(":");
  return async (): Promise<CheckoutBranch | null> => {
    // Stamp before reading: a change during the read shows up next time.
    const stamp = cache && (await stampOf(cache.headPath));
    if (cache && stamp === cache.stamp) return cache.value;
    const target = await checkoutTarget(cwd, home, reader);
    if (!target.checkout) return null;
    const value = {
      name: target.name,
      defaultBranch: target.checkout.defaultBranch,
      headSha: target.overridden ? null : target.checkout.headSha
    };
    cache = {
      stamp:
        stamp !== undefined && cache?.headPath === target.checkout.headPath
          ? stamp
          : await stampOf(target.checkout.headPath),
      headPath: target.checkout.headPath,
      value
    };
    return value;
  };
}

/**
 * Registers the target branch and returns it. It never throws: a detached
 * HEAD, an old API, a network failure or an archived branch all return
 * `branch: null`, and the caller works on the default branch as before.
 */
export async function registerTarget(
  client: AgentApiClient,
  target: CheckoutTarget
): Promise<{ branch: Branch | null; error?: unknown }> {
  if (!target.name) return { branch: null };
  const name = target.name;
  const details = {
    ...(target.checkout?.defaultBranch
      ? { git_default_branch: target.checkout.defaultBranch }
      : {}),
    // An override names another branch than HEAD, so HEAD's commit is not its.
    ...(!target.overridden && target.checkout?.headSha
      ? { head_sha: target.checkout.headSha }
      : {})
  };
  try {
    return {
      branch: (await client.branches.register({ name, ...details })).branch
    };
  } catch (error) {
    if (error instanceof AgentApiError) return { branch: null, error };
    // A default-branch name Orchestrat can't store must not block the rest.
    try {
      return { branch: (await client.branches.register({ name })).branch };
    } catch (retry) {
      return { branch: null, error: retry };
    }
  }
}

/** The client scoped to the checkout's branch, or the client unchanged. */
export async function clientForCheckout(
  client: AgentApiClient,
  cwd: string,
  home: string,
  reader?: GitReader
) {
  const { branch } = await registerTarget(
    client,
    await checkoutTarget(cwd, home, reader)
  );
  return { client: branch ? client.withBranch(branch.id) : client, branch };
}

export type BranchCommandInput = {
  action: "current" | "list" | "create" | "select";
  client: AgentApiClient;
  cwd: string;
  home: string;
  name?: string;
  follow?: boolean;
  includeArchived?: boolean;
  reader?: GitReader;
};

// Local Git never merges, archives or deletes Orchestrat branches: these
// commands only read, register and choose which branch this checkout uses.
export async function runBranchCommand(input: BranchCommandInput) {
  const { client } = input;
  if (input.action === "list")
    return client.branches.list({
      include_archived: input.includeArchived === true
    });
  if (input.action === "create")
    return client.branches.register({ name: input.name!, force_new: true });
  if (input.action === "select") {
    const checkout = await detectCheckout(input.cwd, input.reader);
    if (!checkout) throw new Error("Not inside a Git checkout");
    if (input.follow) {
      await setBranchOverride(input.home, checkout.repoRoot, null);
      return { follow_checkout: true, branch: checkout.branch };
    }
    const [branch] = (await client.branches.list({ name: input.name! }))
      .branches;
    if (!branch)
      throw new Error(
        `No active branch named ${input.name}; create it with orchestrat branch create ${input.name}`
      );
    await setBranchOverride(input.home, checkout.repoRoot, branch.name);
    return { follow_checkout: false, branch };
  }
  const target = await checkoutTarget(input.cwd, input.home, input.reader);
  const { branches } = await client.branches.list();
  return {
    checkout: target.checkout && {
      repo_root: target.checkout.repoRoot,
      branch: target.checkout.branch,
      detached: target.checkout.branch === null,
      default_branch: target.checkout.defaultBranch
    },
    override: target.overridden ? target.name : null,
    branch: branches.find((branch) => branch.name === target.name) ?? null,
    default_branch: branches.find((branch) => branch.is_default) ?? null
  };
}
