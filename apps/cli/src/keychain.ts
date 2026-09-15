import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { apiOrigin } from "./config.js";

const execFileAsync = promisify(execFile);
export const KEYCHAIN_SERVICE = "dev.orchestrat.cli.agent";
export const cliAccount = (api: string) => `cli:${apiOrigin(api)}`;
export const agentAccount = (
  projectId: string,
  integration: string,
  api: string
) => `agent:${projectId}:${integration}:${apiOrigin(api)}`;

export interface CredentialReader {
  read(account: string): Promise<string | undefined>;
}
export interface CredentialStore extends CredentialReader {
  write(account: string, value: string): Promise<void>;
  remove(account: string): Promise<void>;
}

export class KeychainCredentialReader implements CredentialReader {
  constructor(protected readonly service = KEYCHAIN_SERVICE) {}

  async read(account: string): Promise<string | undefined> {
    try {
      const result = await execFileAsync(
        "/usr/bin/security",
        ["find-generic-password", "-a", account, "-s", this.service, "-w"],
        {
          windowsHide: true,
          maxBuffer: 1024 * 1024
        }
      );
      return result.stdout.trim() || undefined;
    } catch (error) {
      const exitCode = (error as NodeJS.ErrnoException & { code?: number })
        .code;
      if (exitCode === 44) return undefined;
      throw new Error("Unable to read Orchestrat credential from Keychain");
    }
  }
}

export class KeychainCredentialStore
  extends KeychainCredentialReader
  implements CredentialStore
{
  async write(account: string, value: string) {
    const failure = () =>
      new Error("Unable to write Orchestrat credential to Keychain");
    const args = [
      "add-generic-password",
      "-U",
      "-a",
      account,
      "-s",
      this.service,
      "-w",
      value
    ];
    // security -i reads a single bounded line; never allow another command or truncation.
    if (args.some((arg) => /[\r\n\0]/.test(arg))) throw failure();
    const command =
      args
        .map(
          (arg) => `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        )
        .join(" ") + "\n";
    if (Buffer.byteLength(command) >= 4096) throw failure();
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "/usr/bin/security",
        ["-i"],
        { windowsHide: true },
        (error, _stdout, stderr) => {
          if (error || stderr.trim()) reject(failure());
          else resolve();
        }
      );
      child.stdin!.on("error", () => reject(failure()));
      child.stdin!.end(command);
    }).catch(() => {
      throw failure();
    });
  }
  async remove(account: string) {
    try {
      await execFileAsync(
        "/usr/bin/security",
        ["delete-generic-password", "-a", account, "-s", this.service],
        { windowsHide: true }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { code?: number }).code !== 44)
        throw new Error("Unable to remove Orchestrat credential from Keychain");
    }
  }
}

export class MemoryCredentialReader implements CredentialReader {
  constructor(
    private readonly values: ReadonlyMap<string, string> = new Map()
  ) {}
  async read(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }
}
