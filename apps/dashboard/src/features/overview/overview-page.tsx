import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
  ArrowUpRight,
  Bot,
  CheckCheck,
  CircleAlert,
  ListTodo,
  Activity,
  CircleCheck,
  Timer
} from "lucide-react";
import type { ProjectContext } from "@/features/hierarchy/catalog";
import {
  agentPresenceQueryOptions,
  agentsQueryOptions,
  projectEventsQueryOptions,
  tasksQueryOptions
} from "@/features/coordination/query-options";
import { derivePresence, onBranch } from "@/features/agents/presence";
import { useBranch } from "@/features/branches/branch-context";
import { DashboardApiError } from "@/lib/api/client";
import { PageState, StatusBadge } from "@/components/dashboard/page";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell
} from "@/components/ui/table";

export function OverviewPage({ context }: { context: ProjectContext }) {
  const { project } = context;
  const { api } = useRouter().options.context;
  const { branchId } = useBranch();
  const tasks = useQuery(tasksQueryOptions(api, project.id, branchId));
  const agents = useQuery(agentsQueryOptions(api, project.id));
  const presence = useQuery(agentPresenceQueryOptions(api, project.id));
  const events = useQuery(projectEventsQueryOptions(api, project.id, branchId));
  const loading =
    tasks.isPending ||
    agents.isPending ||
    presence.isPending ||
    events.isPending;
  const error = tasks.error ?? agents.error ?? presence.error ?? events.error;
  if (loading)
    return <PageState title="Overview" message="Loading project overview…" />;
  if (error)
    return (
      <PageState
        title="Overview unavailable"
        error
        message={
          error instanceof DashboardApiError &&
          error.kind === "PERMISSION_DENIED"
            ? "You don’t have permission to view this project."
            : "We couldn’t load your project. Check your connection and try again."
        }
        onRetry={() =>
          Promise.all([
            tasks.refetch(),
            agents.refetch(),
            presence.refetch(),
            events.refetch()
          ])
        }
      />
    );

  const taskCards = tasks.data!.tasks;
  const taskById = new Map(taskCards.map((task) => [task.id, task]));
  const agentById = new Map(
    agents.data!.agents.map((agent) => [agent.id, agent])
  );
  // Only agents working on this branch (docs/project-branches.md §11.3).
  const online = presence.data!.agents.filter(
    (item) =>
      derivePresence(item.status, item.last_heartbeat_at) === "online" &&
      onBranch(item, branchId)
  );
  const working = online.filter((item) => item.current_task_id !== null);
  const active = taskCards.filter(
    (task) => task.status === "claimed" || task.status === "in_progress"
  ).length;
  const completed = taskCards.filter((task) => task.status === "done").length;
  const needingAttention = taskCards.filter(
    (task) => task.status === "blocked" || task.status === "review"
  );
  const completion = taskCards.length
    ? Math.round((completed / taskCards.length) * 100)
    : 0;
  const meaningfulEvents = events
    .data!.events.filter(
      (event) =>
        !event.type.startsWith("tool.") && !event.type.includes("telemetry")
    )
    .slice(-5)
    .reverse();

  return (
    <section className="dashboard-page" aria-label="Project overview">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Online agents",
            value: online.length,
            detail: `${working.length} working · ${online.length - working.length} idle`,
            icon: Bot
          },
          {
            label: "Active tasks",
            value: active,
            detail: "Claimed or in progress",
            icon: ListTodo
          },
          {
            label: "Needs attention",
            value: needingAttention.length,
            detail: "Blocked or waiting for review",
            icon: CircleAlert
          },
          {
            label: "Completed tasks",
            value: completed,
            detail: `${taskCards.length} tasks on this branch`,
            icon: CheckCheck
          }
        ].map(({ label, value, detail, icon: Icon }) => (
          <Card key={label} className="metric-card">
            <CardHeader>
              <CardDescription>{label}</CardDescription>
              <CardAction>
                <span className="flex size-8 items-center justify-center rounded-lg border bg-background">
                  <Icon
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                </span>
              </CardAction>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tracking-tight">{value}</p>
              <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Work at a glance</h2>
            </CardTitle>
            <CardDescription>
              Where your project stands right now.
            </CardDescription>
            <CardAction>
              <Badge variant="outline">{taskCards.length} tasks</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-3xl font-semibold tracking-tight">
                  {completion}%
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  of tasks completed
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {completed} of {taskCards.length}
              </span>
            </div>
            <Progress
              value={completion}
              aria-label="Task completion"
              className="h-2"
            />
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                {
                  label: "Queued",
                  value: taskCards.filter(
                    (task) =>
                      task.status === "backlog" || task.status === "ready"
                  ).length
                },
                { label: "Active", value: active },
                {
                  label: "Blocked",
                  value: taskCards.filter((task) => task.status === "blocked")
                    .length
                },
                {
                  label: "Review",
                  value: taskCards.filter((task) => task.status === "review")
                    .length
                }
              ].map(({ label, value }) => (
                <div
                  key={label}
                  className={`pl-3 ${label == "Queued" ? "" : "border-l-2"}`}
                >
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 text-lg font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
          <CardFooter>
            <span className="text-xs text-muted-foreground">
              {context.organization.name} ·{" "}
              <span className="font-mono">{project.slug}</span> ·{" "}
              {agents.data!.agents.length} configured agents
            </span>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Tasks needing attention</h2>
            </CardTitle>
            <CardDescription>
              Your next decisions, in one place.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {needingAttention.length ? (
              <ul className="flex max-h-52 flex-col divide-y overflow-auto">
                {needingAttention.map((task) => (
                  <li
                    key={task.id}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-muted-foreground">
                        {task.key}
                      </p>
                      <p
                        className="mt-1 truncate font-medium"
                        title={task.title}
                      >
                        {task.title}
                      </p>
                    </div>
                    <StatusBadge status={task.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <Empty className="min-h-40">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CircleCheck />
                  </EmptyMedia>
                  <EmptyTitle>You’re all caught up</EmptyTitle>
                  <EmptyDescription>
                    Nothing needs attention right now.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Current agent work</h2>
            </CardTitle>
            <CardDescription>
              Live assignments across your connected agents.
            </CardDescription>
            <CardAction>
              <Button
                asChild
                variant="ghost"
                size="icon"
                aria-label="View all agents"
              >
                <Link
                  to="/projects/$projectId/agents"
                  params={{ projectId: project.id }}
                >
                  <ArrowUpRight />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {working.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Task</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {working.map((item) => {
                    const task = taskById.get(item.current_task_id!);
                    return (
                      <TableRow key={item.agent_id}>
                        <TableCell>
                          <span className="flex items-center gap-2 font-medium">
                            <Bot className="size-4 text-muted-foreground" />
                            {agentById.get(item.agent_id)?.name ??
                              "Unknown agent"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-xs text-muted-foreground">
                            {task?.key ?? "Unknown task"}
                          </span>
                          <p
                            className="mt-1 max-w-56 truncate"
                            title={task?.title}
                          >
                            {task?.title}
                          </p>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={task?.status ?? "in_progress"} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <Empty className="min-h-48">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Bot />
                  </EmptyMedia>
                  <EmptyTitle>Ready for the next task</EmptyTitle>
                  <EmptyDescription>
                    No agents are currently working on a task.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Recent activity</h2>
            </CardTitle>
            <CardDescription>
              The latest updates from your project.
            </CardDescription>
            <CardAction>
              <Button
                asChild
                variant="ghost"
                size="icon"
                aria-label="View all activity"
              >
                <Link
                  to="/projects/$projectId/activity"
                  params={{ projectId: project.id }}
                >
                  <ArrowUpRight />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {meaningfulEvents.length ? (
              <ol className="flex flex-col gap-5">
                {meaningfulEvents.map((event) => (
                  <li key={event.id} className="flex items-start gap-3">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full border">
                      <Activity className="size-3.5 text-muted-foreground" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm first-letter:uppercase">
                        {event.type.replace(/[._]/g, " ")}
                      </p>
                      <time
                        dateTime={event.occurred_at}
                        className="mt-1 block text-xs text-muted-foreground"
                      >
                        {new Date(event.occurred_at).toLocaleString()}
                      </time>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty className="min-h-48">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Timer />
                  </EmptyMedia>
                  <EmptyTitle>A fresh start</EmptyTitle>
                  <EmptyDescription>No recent activity.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
