import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Reads a Git checkout from files alone (docs/project-branches.md §7.3):
// spawning `git` in a hook is slow, and on macOS /usr/bin/git can open the
// Xcode installer prompt. Local Git only ever *names* a branch here; it never
// merges, archives or deletes anything in Orchestrat.

export type GitReader = {
  /** The file's text, or undefined when it is missing or unreadable. */
  readFile(path: string): Promise<string | undefined>;
  /** "directory", "file", or undefined when nothing is there. */
  kind(path: string): Promise<"directory" | "file" | undefined>;
};

export type Checkout = {
  /** The working tree root (the directory holding `.git`). */
  repoRoot: string;
  /** This checkout's Git directory; a worktree has its own. */
  gitDir: string;
  /** The shared Git directory with refs (`commondir`, else gitDir). */
  commonDir: string;
  /** `<gitDir>/HEAD`; its mtime changes when the checkout switches branch. */
  headPath: string;
  /** The checked-out branch, or null for a detached HEAD. */
  branch: string | null;
  /** The remote's default branch from `origin/HEAD`, when Git recorded it. */
  defaultBranch: string | null;
  /** The commit HEAD points at, when it can be read. */
  headSha: string | null;
};

export const nodeGitReader: GitReader = {
  async readFile(path) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  },
  async kind(path) {
    try {
      const info = await stat(path);
      return info.isDirectory()
        ? "directory"
        : info.isFile()
          ? "file"
          : undefined;
    } catch {
      return undefined;
    }
  }
};

const shaPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

async function findGitDir(cwd: string, reader: GitReader) {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const dotGit = join(directory, ".git");
    const kind = await reader.kind(dotGit);
    if (kind === "directory") return { repoRoot: directory, gitDir: dotGit };
    if (kind === "file") {
      // Worktrees and submodules: `.git` is a file saying `gitdir: <path>`.
      const pointer = (await reader.readFile(dotGit))?.match(
        /^gitdir:\s*(.+?)\s*$/m
      )?.[1];
      if (pointer)
        return {
          repoRoot: directory,
          gitDir: isAbsolute(pointer) ? pointer : resolve(directory, pointer)
        };
      return null;
    }
    if (dirname(directory) === directory) return null;
  }
}

async function readRef(commonDir: string, ref: string, reader: GitReader) {
  const loose = (await reader.readFile(join(commonDir, ref)))?.trim();
  if (loose && shaPattern.test(loose)) return loose;
  const packed = await reader.readFile(join(commonDir, "packed-refs"));
  for (const line of packed?.split("\n") ?? []) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && sha && shaPattern.test(sha)) return sha;
  }
  return null;
}

/**
 * Finds the checkout that contains `cwd`. It never throws: anything it cannot
 * read comes back as null, and callers fall back to the default branch.
 */
export async function detectCheckout(
  cwd: string,
  reader: GitReader = nodeGitReader
): Promise<Checkout | null> {
  try {
    const found = await findGitDir(cwd, reader);
    if (!found) return null;
    const common = (
      await reader.readFile(join(found.gitDir, "commondir"))
    )?.trim();
    const commonDir = common
      ? isAbsolute(common)
        ? common
        : resolve(found.gitDir, common)
      : found.gitDir;
    const headPath = join(found.gitDir, "HEAD");
    const head = (await reader.readFile(headPath))?.trim();
    if (!head) return null;
    const symbolic = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1] ?? null;
    const headSha = symbolic
      ? await readRef(commonDir, `refs/heads/${symbolic}`, reader)
      : shaPattern.test(head)
        ? head
        : null;
    const originHead = (
      await reader.readFile(join(commonDir, "refs/remotes/origin/HEAD"))
    )?.trim();
    return {
      ...found,
      commonDir,
      headPath,
      branch: symbolic,
      defaultBranch:
        originHead?.match(/^ref:\s*refs\/remotes\/origin\/(.+)$/)?.[1] ?? null,
      headSha
    };
  } catch {
    return null;
  }
}
