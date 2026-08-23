import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  agentPresenceQueryOptions,
  agentsQueryOptions,
  projectEventsQueryOptions
} from "@/features/coordination/query-options";
import { derivePresence } from "@/features/agents/presence";
import { DashboardApiError } from "@/lib/api/client";

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/agents"
)({ component: AgentsRoute });

function AgentsRoute() {
  const { projectId } = Route.useParams();
  const { api } = Route.useRouteContext();
  const agents = useQuery(agentsQueryOptions(api, projectId));
  const presence = useQuery(agentPresenceQueryOptions(api, projectId));
  const events = useQuery(projectEventsQueryOptions(api, projectId));
  if (agents.isPending || presence.isPending)
    return <AgentMessage title="Agents" message="Loading agents…" />;
  if (agents.isError || presence.isError)
    return (
      <AgentMessage
        title="Agents unavailable"
        message={
          agents.error instanceof DashboardApiError &&
          agents.error.kind === "PERMISSION_DENIED"
            ? "You don’t have permission to view agents."
            : "We couldn’t load agents. Check your connection and try again."
        }
      />
    );
  const byAgent = new Map(
    presence.data.agents.map((item) => [item.agent_id, item])
  );
  const recent = [...(events.data?.events ?? [])]
    .filter(
      (event) =>
        !event.type.startsWith("tool.") && !event.type.includes("telemetry")
    )
    .sort((left, right) => right.id - left.id);
  return (
    <main
      id="main-content"
      className="mx-auto w-full max-w-5xl p-6 md:p-8"
      aria-labelledby="agents-heading"
    >
      <h1
        id="agents-heading"
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight"
      >
        Agents
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Connected runtimes and their current project presence.
      </p>
      {agents.data.agents.length === 0 ? (
        <p className="mt-8 rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
          No agents are connected to this project.
        </p>
      ) : (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {agents.data.agents.map((agent) => {
            const item = byAgent.get(agent.id);
            const state = item
              ? derivePresence(item.status, item.last_heartbeat_at)
              : "offline";
            const activity = recent.find(
              (event) => event.actor_agent_id === agent.id
            );
            return (
              <article key={agent.id} className="rounded border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-medium">{agent.name}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Agent runtime details appear when a session is active.
                    </p>
                  </div>
                  <span className="rounded bg-muted px-2 py-1 text-xs capitalize">
                    {state}
                  </span>
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Current task
                    </dt>
                    <dd>
                      {item?.current_task_id ? (
                        <span className="font-mono">
                          {item.current_task_id}
                        </span>
                      ) : (
                        "Idle"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Heartbeat</dt>
                    <dd>
                      {item?.last_heartbeat_at
                        ? heartbeatAge(item.last_heartbeat_at)
                        : "No heartbeat"}
                    </dd>
                  </div>
                </dl>
                <p className="mt-4 text-xs text-muted-foreground">
                  Recent activity:{" "}
                  {activity
                    ? `${activity.type} · ${new Date(activity.occurred_at).toLocaleString()}`
                    : "None recorded"}
                </p>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}

function heartbeatAge(value: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(value)) / 1000)
  );
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}
function AgentMessage({ title, message }: { title: string; message: string }) {
  return (
    <main className="mx-auto w-full max-w-3xl p-6 md:p-8">
      <h1 tabIndex={-1} className="text-2xl font-semibold">
        {title}
      </h1>
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        {message}
      </p>
    </main>
  );
}
