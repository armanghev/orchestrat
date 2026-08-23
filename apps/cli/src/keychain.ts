import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const KEYCHAIN_SERVICE = "dev.orchestrat.cli.agent";

export interface CredentialReader {
  read(account: string): Promise<string | undefined>;
}

export class KeychainCredentialReader implements CredentialReader {
  constructor(private readonly service = KEYCHAIN_SERVICE) {}

  async read(account: string): Promise<string | undefined> {
    try {
      const result = await execFileAsync(
        "security",
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

export class MemoryCredentialReader implements CredentialReader {
  constructor(
    private readonly values: ReadonlyMap<string, string> = new Map()
  ) {}
  async read(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }
}
