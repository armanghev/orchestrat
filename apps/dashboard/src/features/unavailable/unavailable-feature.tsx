import { Link } from "@tanstack/react-router";

export type UnavailableFeature =
  "Tasks" | "Agents" | "Documents" | "Messages" | "Activity" | "Integrations";

const copy = {
  Tasks: [
    "Task service unavailable",
    "The task API is not part of this dashboard build."
  ],
  Agents: [
    "Agent service unavailable",
    "Agent presence and sessions are not available from the current API."
  ],
  Documents: [
    "Document service unavailable",
    "Shared documents and revisions are not available from the current API."
  ],
  Messages: [
    "Messaging service unavailable",
    "Channels and direct messages are not available from the current API."
  ],
  Activity: [
    "Activity service unavailable",
    "The event stream is not available from the current API."
  ],
  Integrations: [
    "Integration service unavailable",
    "MCP, hooks, and local-agent integrations are not available in this build."
  ]
} as const;

export function UnavailableFeaturePage({
  feature,
  projectId
}: {
  feature: UnavailableFeature;
  projectId: string;
}) {
  const [status, description] = copy[feature];
  return (
    <section
      className="mx-auto w-full max-w-3xl p-6 md:p-8"
      aria-labelledby="unavailable-heading"
    >
      <h1
        id="unavailable-heading"
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight"
      >
        {feature}
      </h1>
      <div className="mt-8 border-l-2 pl-5">
        <p className="font-medium">{status}</p>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <Link
          to="/projects/$projectId/overview"
          params={{ projectId }}
          className="mt-5 inline-block text-sm font-medium underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Return to overview
        </Link>
      </div>
    </section>
  );
}
