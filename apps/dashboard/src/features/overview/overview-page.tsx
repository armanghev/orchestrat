import { useQuery } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import type { ProjectContext } from "@/features/hierarchy/catalog";
import {
  agentPresenceQueryOptions,
  agentsQueryOptions,
  projectEventsQueryOptions,
  tasksQueryOptions
} from "@/features/coordination/query-options";
import { useRouter } from "@tanstack/react-router";
import { DashboardApiError } from "@/lib/api/client";

export function OverviewPage({ context }: { context: ProjectContext }) {
  const { project, organization } = context;
  const { api } = useRouter().options.context;
  const tasks = useQuery(tasksQueryOptions(api, project.id));
  const agents = useQuery(agentsQueryOptions(api, project.id));
  const presence = useQuery(agentPresenceQueryOptions(api, project.id));
  const events = useQuery(projectEventsQueryOptions(api, project.id));
  const loading =
    tasks.isPending ||
    agents.isPending ||
    presence.isPending ||
    events.isPending;
  const error = tasks.error ?? agents.error ?? presence.error ?? events.error;
  if (loading)
    return (
      <main className="mx-auto w-full max-w-6xl p-6 md:p-8">
        <h1 tabIndex={-1} className="text-2xl font-semibold">
          Overview
        </h1>
        <p role="status" className="mt-6 text-sm text-muted-foreground">
          Loading mission control…
        </p>
      </main>
    );
  if (error)
    return (
      <main className="mx-auto w-full max-w-3xl p-6 md:p-8">
        <h1 tabIndex={-1} className="text-2xl font-semibold">
          Overview unavailable
        </h1>
        <p role="alert" className="mt-3 text-sm text-muted-foreground">
          {error instanceof DashboardApiError &&
          error.kind === "PERMISSION_DENIED"
            ? "You don’t have permission to view this project."
            : "We couldn’t load mission control data. Check your connection and try again."}
        </p>
      </main>
    );
  const taskCards = tasks.data!.tasks;
  const taskById = new Map(taskCards.map((task) => [task.id, task]));
  const agentById = new Map(
    agents.data!.agents.map((agent) => [agent.id, agent])
  );
  const blockedIds = new Set(
    taskCards.filter((task) => task.status === "blocked").map((task) => task.id)
  );
  const online = presence.data!.agents.filter(
    (item) => item.status === "online"
  );
  const busy = online.filter(
    (item) =>
      item.current_task_id !== null && !blockedIds.has(item.current_task_id)
  ).length;
  const blocked = online.filter(
    (item) =>
      item.current_task_id !== null && blockedIds.has(item.current_task_id)
  ).length;
  const active = taskCards.filter(
    (task) => task.status === "claimed" || task.status === "in_progress"
  ).length;
  const needingAttention = taskCards.filter(
    (task) => task.status === "blocked" || task.status === "review"
  );
  const meaningfulEvents = events
    .data!.events.filter(
      (event) =>
        !event.type.startsWith("tool.") && !event.type.includes("telemetry")
    )
    .slice(-5)
    .reverse();
  return (
    <section
      className="mx-auto w-full max-w-6xl p-6 md:p-8"
      aria-labelledby="overview-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            id="overview-heading"
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight"
          >
            Overview
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {project.description || "Mission control for this project."}
          </p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {project.slug}
          </p>
        </div>
        <p className="flex items-center gap-2 text-sm capitalize">
          {project.status === "archived" ? (
            <Archive aria-hidden="true" className="size-4" />
          ) : null}
          {project.status}
        </p>
      </div>
      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Online agents", online.length],
          ["Busy agents", busy],
          ["Idle agents", Math.max(0, online.length - busy - blocked)],
          ["Blocked agents", blocked]
        ].map(([label, value]) => (
          <div key={label} className="rounded border p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {label}
            </p>
            <p className="mt-2 text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section
          className="rounded border p-5"
          aria-labelledby="overview-tasks-heading"
        >
          <h2 id="overview-tasks-heading" className="font-semibold">
            Work at a glance
          </h2>
          <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Active</dt>
              <dd className="mt-1 text-xl font-semibold">{active}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Blocked</dt>
              <dd className="mt-1 text-xl font-semibold">
                {taskCards.filter((task) => task.status === "blocked").length}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Review</dt>
              <dd className="mt-1 text-xl font-semibold">
                {taskCards.filter((task) => task.status === "review").length}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            {organization.name} · {agents.data!.agents.length} configured agent
            {agents.data!.agents.length === 1 ? "" : "s"}
          </p>
        </section>
        <section
          className="rounded border p-5"
          aria-labelledby="overview-current-heading"
        >
          <h2 id="overview-current-heading" className="font-semibold">
            Current agent work
          </h2>
          {busy || blocked ? (
            <ul className="mt-4 space-y-2 text-sm">
              {presence
                .data!.agents.filter((item) => item.current_task_id)
                .map((item) => (
                  <li key={item.agent_id} className="rounded bg-muted/40 p-2">
                    <span className="font-medium">
                      {agentById.get(item.agent_id)?.name ?? "Unknown agent"}
                    </span>
                    <span className="ml-2">
                      {taskById.get(item.current_task_id!)?.key ??
                        "Unknown task"}
                      {taskById.get(item.current_task_id!)?.title
                        ? ` · ${taskById.get(item.current_task_id!)!.title}`
                        : ""}
                    </span>
                    <span className="ml-2 text-muted-foreground">
                      {blockedIds.has(item.current_task_id!)
                        ? "blocked"
                        : "in progress"}
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              No agents are currently working on a task.
            </p>
          )}
        </section>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section
          className="rounded border p-5"
          aria-labelledby="overview-attention-heading"
        >
          <h2 id="overview-attention-heading" className="font-semibold">
            Tasks needing attention
          </h2>
          {needingAttention.length ? (
            <ul className="mt-4 space-y-2 text-sm">
              {needingAttention.map((task) => (
                <li
                  key={task.id}
                  className="flex justify-between gap-3 rounded bg-muted/40 p-2"
                >
                  <span>
                    {task.key} · {task.title}
                  </span>
                  <span className="capitalize text-muted-foreground">
                    {task.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              Nothing needs attention right now.
            </p>
          )}
        </section>
        <section
          className="rounded border p-5"
          aria-labelledby="overview-events-heading"
        >
          <h2 id="overview-events-heading" className="font-semibold">
            Recent activity
          </h2>
          {meaningfulEvents.length ? (
            <ol className="mt-4 space-y-2 text-sm">
              {meaningfulEvents.map((event) => (
                <li key={event.id} className="rounded bg-muted/40 p-2">
                  <span>{event.type.replace(/[._]/g, " ")}</span>
                  <time className="ml-2 text-xs text-muted-foreground">
                    {new Date(event.occurred_at).toLocaleString()}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              No recent activity.
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
