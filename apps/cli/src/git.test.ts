import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { detectCheckout, type GitReader } from "./git.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
const other = "89abcdef0123456789abcdef0123456789abcdef";

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join("/tmp", "orchestrat-git-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test("reads a normal repository with a slash in the branch name", async (t) => {
  const root = await fixture({
    "repo/.git/HEAD": "ref: refs/heads/feat/login\n",
    "repo/.git/refs/heads/feat/login": `${sha}\n`,
    "repo/.git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/trunk\n",
    "repo/src/app/.keep": ""
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = await detectCheckout(join(root, "repo/src/app"));
  assert.deepEqual(checkout, {
    repoRoot: join(root, "repo"),
    gitDir: join(root, "repo/.git"),
    commonDir: join(root, "repo/.git"),
    headPath: join(root, "repo/.git/HEAD"),
    branch: "feat/login",
    defaultBranch: "trunk",
    headSha: sha
  });
});

test("follows a worktree's gitdir file and commondir", async (t) => {
  const root = await fixture({
    "main/.git/worktrees/wt/HEAD": "ref: refs/heads/feat/wt\n",
    "main/.git/worktrees/wt/commondir": "../..\n",
    "main/.git/packed-refs": `# pack-refs with: peeled\n${other} refs/heads/feat/wt\n`,
    "main/.git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/main\n",
    "wt/.git": "gitdir: ../main/.git/worktrees/wt\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = await detectCheckout(join(root, "wt"));
  assert.equal(checkout?.repoRoot, join(root, "wt"));
  assert.equal(checkout?.gitDir, join(root, "main/.git/worktrees/wt"));
  assert.equal(checkout?.commonDir, join(root, "main/.git"));
  assert.equal(checkout?.headPath, join(root, "main/.git/worktrees/wt/HEAD"));
  assert.equal(checkout?.branch, "feat/wt");
  assert.equal(checkout?.headSha, other, "packed refs are read too");
  assert.equal(checkout?.defaultBranch, "main");
});

test("a detached HEAD or missing origin/HEAD reads as null", async (t) => {
  const root = await fixture({ "repo/.git/HEAD": `${sha}\n` });
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = await detectCheckout(join(root, "repo"));
  assert.equal(checkout?.branch, null);
  assert.equal(checkout?.headSha, sha);
  assert.equal(checkout?.defaultBranch, null);
});

test("never throws: no repository, broken files or a failing reader", async (t) => {
  const root = await fixture({
    "plain/file.txt": "",
    "broken/.git": "not a pointer\n",
    "empty/.git/HEAD": ""
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await detectCheckout(join(root, "plain")), null);
  assert.equal(await detectCheckout(join(root, "broken")), null);
  assert.equal(await detectCheckout(join(root, "empty")), null);
  const failing: GitReader = {
    readFile: async () => {
      throw new Error("EACCES");
    },
    kind: async () => "directory"
  };
  assert.equal(await detectCheckout("/anywhere", failing), null);
});
