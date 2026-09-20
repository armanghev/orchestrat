import { useState } from "react";
import { Bot, Search, HeartPulse } from "lucide-react";
import {
  PageHeader,
  PageState,
  StatusBadge
} from "@/components/dashboard/page";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon
} from "@/components/ui/input-group";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  agentPresenceQueryOptions,
  agentsQueryOptions,
  tasksQueryOptions,
  projectEventsQueryOptions
} from "@/features/coordination/query-options";
import { derivePresence } from "@/features/agents/presence";
import { DashboardApiError } from "@/lib/api/client";

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/agents"
)({ component: AgentsRoute });

function AgentsRoute() {
  const { projectId } = Route.useParams();
  const [search, setSearch] = useState("");
  const { api } = Route.useRouteContext();
  const agents = useQuery(agentsQueryOptions(api, projectId));
  const presence = useQuery(agentPresenceQueryOptions(api, projectId));
  const tasks = useQuery(tasksQueryOptions(api, projectId));
  const events = useQuery(projectEventsQueryOptions(api, projectId));
  if (agents.isPending || presence.isPending)
    return <PageState title="Agents" message="Loading agents…" />;
  if (agents.isError || presence.isError)
    return (
      <PageState
        error
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
  const filtered = agents.data.agents.filter((agent) =>
    agent.name.toLowerCase().includes(search.trim().toLowerCase())
  );
  const taskById = new Map(
    (tasks.data?.tasks ?? []).map((task) => [task.id, task])
  );
  const online = presence.data.agents.filter(
    (item) => derivePresence(item.status, item.last_heartbeat_at) === "online"
  ).length;
  return (
    <section className="dashboard-page" aria-label="Project agents">
      <PageHeader
        title="Agents"
        description="Your connected runtimes, their presence, and what they’re working on."
        actions={
          <Badge variant="outline">
            {online} online · {agents.data.agents.length} total
          </Badge>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Agent directory</h2>
        <InputGroup className="w-full sm:w-64">
          <InputGroupInput
            aria-label="Search agents"
            placeholder="Search agents…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
        </InputGroup>
      </div>
      {!filtered.length ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bot />
            </EmptyMedia>
            <EmptyTitle>
              {agents.data.agents.length
                ? "No matching agents"
                : "Bring your agents together"}
            </EmptyTitle>
            <EmptyDescription>
              {agents.data.agents.length
                ? "Try searching for another agent name."
                : "No agents are connected to this project. Connect a runtime through the Orchestrat CLI to get started."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((agent) => {
            const item = byAgent.get(agent.id);
            const state = item
              ? derivePresence(item.status, item.last_heartbeat_at)
              : "offline";
            const activity = recent.find(
              (event) => event.actor_agent_id === agent.id
            );
            const task = item?.current_task_id
              ? taskById.get(item.current_task_id)
              : null;
            return (
              <Card key={agent.id}>
                <CardHeader>
                  <CardTitle>
                    <h2 className="flex items-center gap-2">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                        <Bot className="size-4 text-muted-foreground" />
                      </span>
                      <span className="truncate" title={agent.name}>
                        {agent.name}
                      </span>
                    </h2>
                  </CardTitle>
                  <CardDescription>Agent runtime</CardDescription>
                  <CardAction>
                    <StatusBadge status={state} />
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <dl className="grid gap-4 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        Current task
                      </dt>
                      <dd className="mt-1.5 font-medium">
                        {task ? (
                          `${task.key} · ${task.title}`
                        ) : item?.current_task_id ? (
                          <span className="break-all font-mono text-xs">
                            {item.current_task_id}
                          </span>
                        ) : (
                          "Idle"
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        Recent activity
                      </dt>
                      <dd className="mt-1.5 text-sm first-letter:uppercase">
                        {activity
                          ? activity.type.replace(/[._]/g, " ")
                          : "None recorded"}
                      </dd>
                    </div>
                  </dl>
                </CardContent>
                <CardFooter className="justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <HeartPulse className="size-3.5" />
                    Heartbeat
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {item?.last_heartbeat_at
                      ? heartbeatAge(item.last_heartbeat_at)
                      : "No heartbeat"}
                  </span>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

function heartbeatAge(value: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(value)) / 1000)
  );
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}
