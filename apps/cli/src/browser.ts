import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions
} from "node:child_process";

export type BrowserCommand = {
  command: string;
  args: string[];
  options: SpawnOptions;
};

export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform
): BrowserCommand {
  if (platform === "darwin")
    return { command: "open", args: [url], options: {} };
  if (platform === "win32")
    // `start` takes its first quoted argument as a window title and cmd
    // treats & as a separator; verbatim arguments stop Node re-quoting both.
    return {
      command: "cmd",
      args: ["/c", "start", '""', url.replaceAll("&", "^&")],
      options: { windowsVerbatimArguments: true }
    };
  return { command: "xdg-open", args: [url], options: {} };
}

export type OpenBrowserOptions = {
  platform?: NodeJS.Platform;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcess;
  // A launcher still running after this long (xdg-open can wait for the
  // browser it started) counts as opened and is left running.
  settleMs?: number;
};

// Resolves false when the launcher is missing or exits with an error.
export function openBrowser(
  url: string,
  options: OpenBrowserOptions = {}
): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return Promise.resolve(false);
  const platform = options.platform ?? process.platform;
  const {
    command,
    args,
    options: spawnOptions
  } = browserCommand(url, platform);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = (options.spawn ?? nodeSpawn)(command, args, {
        stdio: "ignore",
        detached: platform !== "win32",
        windowsHide: true,
        ...spawnOptions
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.unref();
      resolve(true);
    }, options.settleMs ?? 2000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

// Opens the approval page, or prints its URL when no browser can be opened.
export async function openApprovalUrl(
  url: string,
  write: (text: string) => void,
  options: OpenBrowserOptions = {}
) {
  if (await openBrowser(url, options)) return;
  write(
    `orchestrat: could not open a browser. Open this URL to approve the CLI:\n  ${url}\n`
  );
}
