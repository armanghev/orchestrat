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
    return <ActivityMessage title="Activity" message="Loading activity…" />;
  if (activity.isError)
    return (
      <ActivityMessage
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
    <main
      id="main-content"
      className="mx-auto w-full max-w-5xl p-6 md:p-8"
      aria-labelledby="activity-heading"
    >
      <h1
        id="activity-heading"
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight"
      >
        Activity
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Durable project events from agents and humans.
      </p>
      {events.length === 0 ? (
        <p className="mt-8 rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
          No meaningful activity has been recorded yet.
        </p>
      ) : (
        <ol className="mt-8 divide-y rounded border">
          {groups.map(({ event, events: groupedEvents }) => (
            <li key={event.id} className="p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">
                  {formatEvent(event.type)}
                  {groupedEvents.length > 1
                    ? ` (${groupedEvents.length} revisions)`
                    : ""}
                </span>
                <time
                  dateTime={event.occurred_at}
                  className="text-xs text-muted-foreground"
                >
                  {new Date(event.occurred_at).toLocaleString()}
                </time>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {event.actor_agent_id
                  ? `Agent ${event.actor_agent_id}`
                  : event.actor_user_id
                    ? `User ${event.actor_user_id}`
                    : "System"}
                {event.entity_id ? ` · ${event.entity_id}` : ""}
              </p>
            </li>
          ))}
        </ol>
      )}
      {activity.hasNextPage ? (
        <button
          type="button"
          className="mt-5 text-sm font-medium underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => void activity.fetchNextPage()}
          disabled={activity.isFetchingNextPage}
        >
          {activity.isFetchingNextPage ? "Loading more…" : "Load more activity"}
        </button>
      ) : null}
    </main>
  );
}

function formatEvent(type: string) {
  return type
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
function ActivityMessage({
  title,
  message
}: {
  title: string;
  message: string;
}) {
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
