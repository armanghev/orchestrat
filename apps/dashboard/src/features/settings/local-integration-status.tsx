import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent
} from "@/components/ui/card";
import { useEffect, useState } from "react";
import { usePlatform } from "@/platform/provider";
import type { LocalIntegrationStatus } from "@/platform/contract";

export function LocalIntegrationStatusSection({
  projectId
}: {
  projectId: string;
}) {
  const platform = usePlatform();
  const [status, setStatus] = useState<LocalIntegrationStatus | null>(
    platform.localIntegrationStatus
      ? null
      : {
          supported: false,
          cli_exists: false,
          project_mapping: false,
          integrations: {},
          error: "Local integration status is unavailable here."
        }
  );
  useEffect(() => {
    if (!platform.localIntegrationStatus) return;
    let active = true;
    void platform
      .localIntegrationStatus(projectId)
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active)
          setStatus({
            supported: platform.kind === "desktop",
            cli_exists: false,
            project_mapping: false,
            integrations: {},
            error: "Unable to read local integration status."
          });
      });
    return () => {
      active = false;
    };
  }, [platform, projectId]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="local-integrations-heading">Local agent integrations</h2>
        </CardTitle>
        <CardDescription>
          Read-only readiness for this project on the current computer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!status ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking local integrations…
          </p>
        ) : status.error || !status.supported ? (
          <p role="status" className="text-sm text-muted-foreground">
            {status.error ?? "Local integration status is unavailable here."}
          </p>
        ) : (
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
              <div key={name} className="rounded-md border px-3 py-2 text-sm">
                <dt className="font-medium">{name}</dt>
                <dd className="mt-1 text-muted-foreground">
                  {value?.mapped && value.mcp && value.hooks && value.credential
                    ? "Ready"
                    : "Not ready"}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
