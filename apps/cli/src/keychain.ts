import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const KEYCHAIN_SERVICE = "dev.orchestrat.cli.agent";
export const agentAccount = (projectId: string, integration: string) =>
  `agent:${projectId}:${integration}`;
export const legacyAgentAccount = (integration: string) =>
  `agent:${integration}`;

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

export class KeychainCredentialStore
  extends KeychainCredentialReader
  implements CredentialStore
{
  async write(account: string, value: string) {
    await execFileAsync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-a",
        account,
        "-s",
        this.service,
        "-w",
        value
      ],
      { windowsHide: true }
    );
  }
  async remove(account: string) {
    try {
      await execFileAsync(
        "security",
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
