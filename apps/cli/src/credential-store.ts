import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  KEYCHAIN_SERVICE,
  KeychainCredentialStore,
  type CredentialStore
} from "./keychain.js";

// Accounts keep the per-API-origin layout from keychain.ts on every
// backend; only where the secret lives changes by platform.

// $XDG_CONFIG_HOME/orchestrat/credentials.json, with ~/.config when the
// variable is unset or relative (the XDG spec ignores relative values).
export function credentialsFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
) {
  const configHome =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(home, ".config");
  return join(configHome, "orchestrat", "credentials.json");
}

type CredentialFile = { version: 1; credentials: Record<string, string> };

// A 0600 JSON file in a 0700 directory, replaced atomically on every write.
export class FileCredentialStore implements CredentialStore {
  constructor(
    readonly path: string,
    // Called once, when this store creates the file.
    private readonly onCreate?: (path: string) => void
  ) {}

  async read(account: string) {
    return (await this.load())?.credentials[account];
  }

  async write(account: string, value: string) {
    if (!account || !value)
      throw new Error("Unable to write Orchestrat credentials file");
    const current = await this.load();
    await this.save(
      {
        version: 1,
        credentials: { ...current?.credentials, [account]: value }
      },
      current === undefined
    );
  }

  async remove(account: string) {
    const current = await this.load();
    if (!current || !Object.hasOwn(current.credentials, account)) return;
    const credentials = { ...current.credentials };
    delete credentials[account];
    await this.save({ version: 1, credentials }, false);
  }

  private async load(): Promise<CredentialFile | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(
        `Unable to read Orchestrat credentials file ${this.path}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const file = parsed as Partial<CredentialFile> | undefined;
    if (
      !file ||
      typeof file !== "object" ||
      file.version !== 1 ||
      !file.credentials ||
      typeof file.credentials !== "object" ||
      Array.isArray(file.credentials) ||
      Object.values(file.credentials).some((value) => typeof value !== "string")
    )
      throw new Error(`Orchestrat credentials file is malformed: ${this.path}`);
    return { version: 1, credentials: { ...file.credentials } };
  }

  private async save(file: CredentialFile, created: boolean) {
    const directory = dirname(this.path);
    const temporary = join(
      directory,
      `.credentials-${process.pid}-${randomBytes(6).toString("hex")}.tmp`
    );
    try {
      await mkdir(dirname(directory), { recursive: true });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error(
        `Unable to write Orchestrat credentials file ${this.path}`
      );
    }
    if (created) this.onCreate?.(this.path);
  }
}

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};
// Rejects only when the command cannot be started (for example ENOENT).
export type CommandRunner = (
  command: string,
  args: readonly string[],
  input?: string
) => Promise<CommandResult>;

// Long enough to answer a keyring unlock prompt.
const COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 64 * 1024;

export const runCommand: CommandRunner = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin!.once("error", () => undefined);
    child.stdin!.end(input ?? "");
  });

// libsecret's secret-tool. Secrets travel on stdin, never in arguments.
// `lookup` and `clear` exit 1 with empty stderr when nothing matches; any
// other failure (no D-Bus session, no Secret Service, a dismissed prompt)
// prints to stderr.
export class SecretToolCredentialStore implements CredentialStore {
  constructor(
    private readonly run: CommandRunner = runCommand,
    private readonly service = KEYCHAIN_SERVICE
  ) {}

  private attributes(account: string) {
    return ["service", this.service, "account", account];
  }

  private async secretTool(args: string[], input?: string) {
    try {
      return await this.run("secret-tool", args, input);
    } catch {
      throw new Error("secret-tool is unavailable");
    }
  }

  async read(account: string) {
    const result = await this.secretTool([
      "lookup",
      ...this.attributes(account)
    ]);
    if (result.code === 0) return result.stdout.trim() || undefined;
    if (result.code === 1 && !result.stderr.trim()) return undefined;
    throw new Error("Unable to read Orchestrat credential from secret-tool");
  }

  async write(account: string, value: string) {
    const result = await this.secretTool(
      [
        "store",
        "--label=Orchestrat CLI credential",
        ...this.attributes(account)
      ],
      value
    );
    if (result.code !== 0 || result.stderr.trim())
      throw new Error("Unable to write Orchestrat credential to secret-tool");
  }

  async remove(account: string) {
    const result = await this.secretTool([
      "clear",
      ...this.attributes(account)
    ]);
    if (result.code === 0) return;
    if (result.code === 1 && !result.stderr.trim()) return;
    throw new Error("Unable to remove Orchestrat credential from secret-tool");
  }
}

// Uses the primary store until it fails once, then only the fallback. Reads
// also check the fallback, so a credential saved while the primary was
// unavailable is still found.
export class FallbackCredentialStore implements CredentialStore {
  #primaryFailed = false;

  constructor(
    readonly primary: CredentialStore,
    readonly fallback: CredentialStore
  ) {}

  private async attempt<T>(
    operation: (store: CredentialStore) => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    if (this.#primaryFailed) return { ok: false };
    try {
      return { ok: true, value: await operation(this.primary) };
    } catch {
      this.#primaryFailed = true;
      return { ok: false };
    }
  }

  async read(account: string) {
    const primary = await this.attempt((store) => store.read(account));
    if (primary.ok && primary.value !== undefined) return primary.value;
    return this.fallback.read(account);
  }

  async write(account: string, value: string) {
    if ((await this.attempt((store) => store.write(account, value))).ok) {
      // Drop a copy saved while the primary was unavailable.
      await this.fallback.remove(account).catch(() => undefined);
      return;
    }
    await this.fallback.write(account, value);
  }

  async remove(account: string) {
    await this.attempt((store) => store.remove(account));
    await this.fallback.remove(account);
  }
}

export type CredentialStoreOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: CommandRunner;
  warn?: (message: string) => void;
};

// macOS: Keychain. Linux: secret-tool when it is installed and working,
// else the file. Anything else: the file, with a warning when it is created.
export function platformCredentialStore(
  options: CredentialStoreOptions = {}
): CredentialStore {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return new KeychainCredentialStore();
  const path = credentialsFilePath(options.env ?? process.env, options.home);
  if (platform === "linux")
    return new FallbackCredentialStore(
      new SecretToolCredentialStore(options.run),
      new FileCredentialStore(path)
    );
  const warn =
    options.warn ?? ((message: string) => process.stderr.write(message));
  return new FileCredentialStore(path, (created) =>
    warn(
      `orchestrat: no system credential store is supported on ${platform}; credentials are saved in a plain file at ${created}\n`
    )
  );
}
