import { Activity, Bot, User, FileText } from "lucide-react";
import { PageHeader, PageState } from "@/components/dashboard/page";
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
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { coordinationKeys } from "@/features/coordination/query-options";
import { groupActivityEvents } from "@/features/coordination/group-activity-events";
import { DashboardApiError } from "@/lib/api/client";

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/activity"
)({ component: ActivityRoute });

function ActivityRoute() {
  const { projectId } = Route.useParams();
  const { api } = Route.useRouteContext();
  const activity = useInfiniteQuery({
    queryKey: coordinationKeys.eventsInfinite(projectId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listProjectEvents(projectId, { limit: 50, after: pageParam }),
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
  return (
    <section className="dashboard-page" aria-label="Project activity">
      <PageHeader
        title="Activity"
        description="A shared timeline of changes from your agents and team."
        actions={<Badge variant="outline">{events.length} events loaded</Badge>}
      />
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
                          {formatEvent(event.type)}
                          {groupedEvents.length > 1
                            ? ` (${groupedEvents.length} revisions)`
                            : ""}
                        </h3>
                        <time
                          dateTime={event.occurred_at}
                          className="text-xs text-muted-foreground"
                        >
                          {new Date(event.occurred_at).toLocaleString()}
                        </time>
                      </div>
                      <p className="mt-1.5 break-all text-xs text-muted-foreground">
                        {event.actor_agent_id
                          ? `Agent ${event.actor_agent_id}`
                          : event.actor_user_id
                            ? `User ${event.actor_user_id}`
                            : "System"}
                        {event.entity_id ? ` · ${event.entity_id}` : ""}
                      </p>
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

function formatEvent(type: string) {
  return type
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
