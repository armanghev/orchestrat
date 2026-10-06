import { Activity, Bot, User, FileText } from "lucide-react";
import { PageState } from "@/components/dashboard/page";
import { TopToolbarActions } from "@/components/app-shell/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent
} from "@/components/ui/card";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription
} from "@/components/ui/empty";
import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  ALL_BRANCHES,
  coordinationKeys
} from "@/features/coordination/query-options";
import { groupActivityEvents } from "@/features/coordination/group-activity-events";
import {
  activitySuffix,
  activityTaskId,
  activityVerb
} from "@/features/coordination/activity-copy";
import {
  agentsQueryOptions,
  documentsQueryOptions,
  tasksQueryOptions
} from "@/features/coordination/query-options";
import { organizationMembersQueryOptions } from "@/features/hierarchy/query-options";
import { useBranch } from "@/features/branches/branch-context";
import { DashboardApiError } from "@/lib/api/client";

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/activity"
)({ component: ActivityRoute });

function ActivityRoute() {
  const { projectId } = Route.useParams();
  const { api, project } = Route.useRouteContext();
  const { branchId, branchName } = useBranch();
  // This branch plus project-wide events, or every branch (spec §11.3).
  const [allBranches, setAllBranches] = useState(false);
  const tasks = useQuery(tasksQueryOptions(api, projectId, branchId));
  const agents = useQuery(agentsQueryOptions(api, projectId));
  const documents = useQuery(documentsQueryOptions(api, projectId, branchId));
  const members = useQuery(
    organizationMembersQueryOptions(api, project?.project.organization_id ?? "")
  );
  const activity = useInfiniteQuery({
    queryKey: coordinationKeys.eventsInfinite(
      projectId,
      allBranches ? ALL_BRANCHES : branchId
    ),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listProjectEvents(
        projectId,
        { limit: 50, after: pageParam },
        allBranches ? { allBranches: true } : { branchId }
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined
  });
  if (activity.isPending)
    return <PageState title="Activity" message="Loading activity…" />;
  if (activity.isError)
    return (
      <PageState
        error
        title="Activity unavailable"
        message={
          activity.error instanceof DashboardApiError &&
          activity.error.kind === "PERMISSION_DENIED"
            ? "You don’t have permission to view activity."
            : "We couldn’t load activity. Check your connection and try again."
        }
      />
    );
  const events = [
    ...new Map(
      activity.data.pages
        .flatMap((page) => page.events)
        .filter(
          (event) =>
            !event.type.startsWith("tool.") && !event.type.includes("telemetry")
        )
        .map((event) => [event.id, event])
    ).values()
  ].sort((left, right) => right.id - left.id);
  const groups = groupActivityEvents(events);
  const taskById = new Map(
    (tasks.data?.tasks ?? []).map((task) => [task.id, task])
  );
  const documentById = new Map(
    (documents.data?.documents ?? []).map((document) => [document.id, document])
  );
  const agentById = new Map(
    (agents.data?.agents ?? []).map((agent) => [agent.id, agent])
  );
  const memberById = new Map(
    (members.data?.members ?? []).map((member) => [member.user_id, member])
  );
  const participantName = (participant: {
    type: "human" | "agent";
    id: string;
  }) =>
    participant.type === "agent"
      ? agentById.get(participant.id)?.name
      : memberById.get(participant.id)?.full_name;
  return (
    <section className="dashboard-page" aria-label="Project activity">
      <TopToolbarActions>
        <Badge variant="outline">{events.length} events loaded</Badge>
        <Button
          type="button"
          size="sm"
          variant={allBranches ? "secondary" : "outline"}
          aria-pressed={allBranches}
          onClick={() => setAllBranches((current) => !current)}
        >
          All branches
        </Button>
      </TopToolbarActions>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Project timeline</h2>
          </CardTitle>
          <CardDescription>
            Most recent first. Consecutive document saves are grouped.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!events.length ? (
            <Empty className="min-h-72">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Activity />
                </EmptyMedia>
                <EmptyTitle>Your project’s story starts here</EmptyTitle>
                <EmptyDescription>
                  No meaningful activity has been recorded yet.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ol className="flex flex-col">
              {groups.map(({ event, events: groupedEvents }) => {
                const taskId = activityTaskId(event);
                const task = taskId ? taskById.get(taskId) : undefined;
                const otherBranch =
                  event.branch_id && event.branch_id !== branchId
                    ? (branchName(event.branch_id) ?? "another branch")
                    : null;
                const document = event.entity_id
                  ? documentById.get(event.entity_id)
                  : undefined;
                const targetAgent =
                  event.type.startsWith("agent.") && event.entity_id
                    ? agentById.get(event.entity_id)
                    : undefined;
                const actor = event.actor_agent_id
                  ? (agentById.get(event.actor_agent_id)?.name ?? "An agent")
                  : event.actor_user_id
                    ? (memberById.get(event.actor_user_id)?.full_name ??
                      "A member")
                    : "System";
                const Icon = event.type.startsWith("document")
                  ? FileText
                  : event.actor_agent_id
                    ? Bot
                    : event.actor_user_id
                      ? User
                      : Activity;
                return (
                  <li
                    key={event.id}
                    className="relative flex gap-4 pb-7 last:pb-0"
                  >
                    <div
                      className="absolute left-4 top-9 bottom-0 w-px bg-border"
                      aria-hidden="true"
                    />
                    <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full border bg-card">
                      <Icon
                        className="size-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </span>
                    <div className="min-w-0 flex-1 pt-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-medium">
                          {actor} {activityVerb(event.type, event.payload)}{" "}
                          {task ? (
                            <Link
                              to="/projects/$projectId/tasks"
                              params={{ projectId }}
                              search={{ task: task.id }}
                              className="font-mono text-primary underline-offset-4 hover:underline"
                            >
                              {task.key}
                            </Link>
                          ) : document ? (
                            document.path
                          ) : event.type.startsWith("agent.") ? (
                            (targetAgent?.name ?? "an agent")
                          ) : event.type.startsWith("task.") ? (
                            "a task"
                          ) : event.type.startsWith("document.") ? (
                            "a document"
                          ) : event.type === "chat.handoff_created" ? (
                            "work"
                          ) : null}
                          {activitySuffix(event, participantName)}
                          {groupedEvents.length > 1
                            ? ` (${groupedEvents.length} revisions)`
                            : ""}
                        </h3>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          {otherBranch ? <span>in {otherBranch}</span> : null}
                          <time dateTime={event.occurred_at}>
                            {new Date(event.occurred_at).toLocaleString()}
                          </time>
                        </span>
                      </div>
                      {task ? (
                        <p className="mt-1.5 truncate text-xs text-muted-foreground">
                          {task.key} · {task.title}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
      {activity.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          onClick={() => void activity.fetchNextPage()}
          disabled={activity.isFetchingNextPage}
        >
          {activity.isFetchingNextPage ? "Loading more…" : "Load more activity"}
        </Button>
      ) : null}
    </section>
  );
}
