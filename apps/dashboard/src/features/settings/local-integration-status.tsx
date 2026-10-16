import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { usePlatform } from "@/platform/provider";
import type { LocalIntegrationStatus } from "@/platform/contract";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const httpOrigin = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
};
// The CLI has no default server. Setup commands name this dashboard's own
// API origin with --server, and only set ORCHESTRAT_WEB_URL when the
// dashboard is not served from that origin (the CLI's default).
export function buildCliCommands(
  kind: "desktop" | "web",
  input: { apiUrl?: string; webUrl?: string } = {
    apiUrl: import.meta.env.VITE_API_URL
  },
  currentOrigin = typeof window !== "undefined"
    ? window.location.origin
    : undefined
) {
  const pageOrigin = kind === "web" ? httpOrigin(currentOrigin) : undefined;
  const apiUrl = httpOrigin(input.apiUrl) ?? pageOrigin;
  const webUrl = httpOrigin(input.webUrl) ?? pageOrigin;
  const environment =
    webUrl && webUrl !== apiUrl
      ? `ORCHESTRAT_WEB_URL=${shellQuote(webUrl)} `
      : "";
  const server = apiUrl ? ` --server ${shellQuote(apiUrl)}` : "";
  return {
    setup: `${environment}npx @orchestrat/cli@latest setup${server}`,
    installedSetup: `${environment}orchestrat setup${server}`,
    status: "orchestrat status",
    doctor: "orchestrat doctor"
  };
}

const fallbackStatus = (message: string, supported = false) => ({
  supported,
  cli_exists: false,
  project_mapping: false,
  integrations: {},
  error: message
});

export function LocalIntegrationStatusSection({
  projectId
}: {
  projectId: string;
}) {
  const platform = usePlatform();
  const [status, setStatus] = useState<LocalIntegrationStatus | null>(
    platform.localIntegrationStatus
      ? null
      : fallbackStatus("Local integration status is unavailable here.")
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const previousProjectId = useRef(projectId);
  useEffect(() => {
    let active = true;
    if (previousProjectId.current !== projectId) {
      previousProjectId.current = projectId;
      setStatus(null);
    }
    if (!platform.localIntegrationStatus) {
      setStatus(
        fallbackStatus("Local integration status is unavailable here.")
      );
      setRefreshing(false);
      return () => {
        active = false;
      };
    }
    setRefreshing(true);
    void platform
      .localIntegrationStatus(projectId)
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active)
          setStatus(
            fallbackStatus(
              "Unable to read local integration status.",
              platform.kind === "desktop"
            )
          );
      })
      .finally(() => {
        if (active) setRefreshing(false);
      });
    return () => {
      active = false;
    };
  }, [platform, projectId, refreshKey]);

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied.`);
    } catch {
      setCopyStatus(`Could not copy ${label.toLowerCase()}.`);
    }
  }

  const hasStatus = status?.supported && !status.error;
  const {
    setup: setupCommand,
    installedSetup: installedSetupCommand,
    status: statusCommand,
    doctor: doctorCommand
  } = buildCliCommands(platform.kind);
  const setupHelp = (
    <div className="mt-5 space-y-4 rounded-md border bg-muted/30 p-4">
      <div>
        <h3 className="font-medium">Connect this project from its checkout</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Run setup in the local directory for this project, then select this
          project when the CLI prompts you. The dashboard never runs setup for
          you.
        </p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <code
            tabIndex={0}
            aria-label="Setup command"
            className="min-w-0 flex-1 overflow-x-auto rounded bg-background px-2 py-1 text-xs"
          >
            {setupCommand}
          </code>
          <Button
            variant="outline"
            size="sm"
            aria-label="Copy setup command"
            onClick={() => void copy(setupCommand, "Setup command")}
          >
            Copy
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Already have the launcher installed? Use{" "}
          <code>{installedSetupCommand}</code>.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {[statusCommand, doctorCommand].map((command) => (
          <div key={command} className="flex items-center gap-2">
            <code
              tabIndex={0}
              aria-label="Local integration command"
              className="min-w-0 flex-1 overflow-x-auto rounded bg-background px-2 py-1 text-xs"
            >
              {command}
            </code>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Copy ${command}`}
              onClick={() => void copy(command, command)}
            >
              Copy
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          Select project ID <code className="break-all">{projectId}</code>
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void copy(projectId, "Project ID")}
        >
          Copy project ID
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Supported setup targets: Claude Code, Codex, Cursor, and Antigravity. Pi
        is detected but has no stable MCP configuration path.
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer font-medium text-primary">
          Read the local agent setup guide
        </summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          <p>
            Setup requires macOS or Linux, Node.js 20+, an account on this
            Orchestrat server, and a local project checkout.
          </p>
          <p>
            Setup previews managed changes before writing them, stores
            credentials in the macOS Keychain or, on Linux, the Secret Service
            or a private file, and is safe to repeat. It does not run from this
            dashboard.
          </p>
          <p>
            Claude Code, Codex, Cursor, and Antigravity receive MCP and hooks.
            Pi is detected but cannot be configured through a stable MCP
            contract.
          </p>
        </div>
      </details>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>
              <h2 id="local-integrations-heading">Local agent integrations</h2>
            </CardTitle>
            <CardDescription>
              Read-only readiness for this project on the current computer.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!platform.localIntegrationStatus || refreshing}
            onClick={() => setRefreshKey((value) => value + 1)}
          >
            {refreshing ? "Refreshing…" : "Refresh status"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!status ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking local integrations…
          </p>
        ) : (
          <>
            {status.error ? (
              <p role="alert" className="text-sm text-muted-foreground">
                {status.error}
              </p>
            ) : null}
            {hasStatus ? (
              <>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <dt>CLI</dt>
                    <dd>{status.cli_exists ? "Ready" : "Not ready"}</dd>
                  </div>
                  <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <dt>Project mapping</dt>
                    <dd>{status.project_mapping ? "Ready" : "Not ready"}</dd>
                  </div>
                  {Object.entries(status.integrations).map(([name, value]) => (
                    <div
                      key={name}
                      className="rounded-md border px-3 py-2 text-sm"
                    >
                      <dt className="font-medium">{name}</dt>
                      <dd className="mt-1 text-muted-foreground">
                        {value?.mapped &&
                        value.mcp &&
                        value.hooks &&
                        value.credential
                          ? "Ready"
                          : value?.mapped
                            ? "Needs attention"
                            : "Not connected"}
                      </dd>
                    </div>
                  ))}
                </dl>
                {!status.project_mapping ? (
                  <p
                    role="status"
                    className="mt-4 text-sm text-muted-foreground"
                  >
                    No local connection is mapped to this project yet.
                  </p>
                ) : null}
              </>
            ) : status.supported ? (
              <p role="status" className="text-sm text-muted-foreground">
                Status could not be read from this desktop. Run the CLI
                diagnostics below to inspect or repair the local connection.
              </p>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                The browser cannot inspect local agent configuration. Use the
                commands below from your project checkout.
              </p>
            )}
            {setupHelp}
            {copyStatus ? (
              <p role="status" className="mt-3 text-sm text-muted-foreground">
                {copyStatus}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
