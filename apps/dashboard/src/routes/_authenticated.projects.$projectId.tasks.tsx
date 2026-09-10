import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  coordinationKeys,
  taskCommentsQueryOptions,
  taskDependenciesQueryOptions,
  taskQueryOptions,
  tasksQueryOptions
} from "@/features/coordination/query-options";
import { DashboardApiError } from "@/lib/api/client";
import type { HumanTaskStatus, Task, TaskPriority } from "@orchestrat/protocol";

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/tasks"
)({ component: TasksRoute });
const statuses: HumanTaskStatus[] = [
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "done",
  "cancelled"
];
const boardStatuses: Task["status"][] = [
  ...statuses.slice(0, 2),
  "claimed",
  ...statuses.slice(2)
];
const priorities: TaskPriority[] = ["urgent", "high", "medium", "low", "none"];

function TasksRoute() {
  const { projectId } = Route.useParams();
  const { api, project } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tasks = useQuery(tasksQueryOptions(api, projectId));
  const taskId = selectedTaskId ?? "00000000-0000-4000-8000-000000000000";
  const selected = useQuery({
    ...taskQueryOptions(api, taskId),
    enabled: selectedTaskId !== null
  });
  const comments = useQuery({
    ...taskCommentsQueryOptions(api, taskId),
    enabled: selectedTaskId !== null
  });
  const dependencies = useQuery({
    ...taskDependenciesQueryOptions(api, taskId),
    enabled: selectedTaskId !== null
  });
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: coordinationKeys.tasks(projectId)
    });
  const message = (error: unknown) =>
    error instanceof DashboardApiError
      ? error.kind === "NETWORK_ERROR"
        ? "We couldn’t reach the Dashboard API. Check your connection and try again."
        : error.kind === "PERMISSION_DENIED"
          ? "You don’t have permission to view these tasks."
          : error.message
      : "Something went wrong. Try again.";
  const create = useMutation({
    mutationFn: (input: {
      title: string;
      description: string | null;
      priority: TaskPriority;
      status: HumanTaskStatus;
    }) => api.createTask(projectId, input, crypto.randomUUID()),
    onSuccess: async (task) => {
      setSelectedTaskId(task.id);
      await refresh();
    }
  });
  const conflict = async () => {
    setNotice(
      "This task changed elsewhere. The latest version was reloaded; review it before trying again."
    );
    await refresh();
    await queryClient.invalidateQueries({
      queryKey: coordinationKeys.task(taskId)
    });
  };
  const update = useMutation({
    mutationFn: ({
      id,
      input
    }: {
      id: string;
      input: Parameters<typeof api.updateTask>[1];
    }) => api.updateTask(id, input),
    onSuccess: async (task) => {
      setNotice(null);
      await queryClient.invalidateQueries({
        queryKey: coordinationKeys.task(task.id)
      });
      await refresh();
    },
    onError: async (error) => {
      if (
        error instanceof DashboardApiError &&
        error.kind === "TASK_VERSION_CONFLICT"
      )
        await conflict();
      else setNotice(message(error));
    }
  });
  const move = useMutation({
    mutationFn: ({
      id,
      status,
      version
    }: {
      id: string;
      status: HumanTaskStatus;
      version: number;
    }) => api.moveTask(id, { status, expected_version: version }),
    onSuccess: async () => {
      setNotice(null);
      await refresh();
      await queryClient.invalidateQueries({
        queryKey: coordinationKeys.task(taskId)
      });
    },
    onError: async (error) => {
      if (
        error instanceof DashboardApiError &&
        error.kind === "TASK_VERSION_CONFLICT"
      )
        await conflict();
      else setNotice(message(error));
    }
  });
  const addComment = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      api.createTaskComment(id, { body_markdown: body }, crypto.randomUUID()),
    onSuccess: async () => {
      setNotice(null);
      await queryClient.invalidateQueries({
        queryKey: coordinationKeys.comments(taskId)
      });
    },
    onError: (error) => setNotice(message(error))
  });
  if (tasks.isPending)
    return <TaskMessage title="Tasks" message="Loading tasks…" />;
  if (tasks.isError)
    return (
      <TaskMessage
        title="Tasks unavailable"
        message={message(tasks.error)}
        onRetry={refresh}
      />
    );
  const grouped = boardStatuses.map((status) => ({
    status,
    tasks: tasks.data.tasks.filter((task) => task.status === status)
  }));
  return (
    <div
      className="mx-auto w-full max-w-6xl p-6 md:p-8"
      aria-labelledby="tasks-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            id="tasks-heading"
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight"
          >
            Tasks
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Create and coordinate project work.
          </p>
        </div>
        {project?.project.status === "archived" ? (
          <p className="rounded border px-3 py-2 text-sm text-muted-foreground">
            This project is archived and read-only.
          </p>
        ) : null}
      </div>
      {notice ? (
        <p
          role="alert"
          className="mt-5 rounded border border-amber-500/50 px-3 py-2 text-sm"
        >
          {notice}
        </p>
      ) : null}
      <CreateTaskForm
        disabled={project?.project.status === "archived" || create.isPending}
        error={create.error ? message(create.error) : null}
        onCreate={(input) => create.mutate(input)}
      />
      {tasks.data.tasks.length === 0 ? (
        <p className="mt-8 rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
          No tasks yet. Create the first task above.
        </p>
      ) : (
        <div className="mt-8 grid gap-4 xl:grid-cols-4">
          {grouped.map(({ status, tasks: column }) => (
            <section
              key={status}
              aria-labelledby={`status-${status}`}
              className="min-h-32 rounded border bg-card/30 p-3"
            >
              <h2
                id={`status-${status}`}
                className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {status.replace("_", " ")}
              </h2>
              <div className="mt-3 space-y-2">
                {column.map((task) => (
                  <button
                    type="button"
                    key={task.id}
                    onClick={() => {
                      setSelectedTaskId(task.id);
                      setNotice(null);
                    }}
                    className="w-full rounded border p-3 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="font-mono text-xs text-muted-foreground">
                      {task.key}
                    </span>
                    <span className="mt-1 block text-sm font-medium">
                      {task.title}
                    </span>
                    <span className="mt-2 block text-xs capitalize text-muted-foreground">
                      {task.priority} priority · v{task.version}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {selectedTaskId && selected.isPending ? (
        <p role="status" className="mt-8 text-sm text-muted-foreground">
          Loading task details…
        </p>
      ) : null}
      {selectedTaskId && selected.isError ? (
        <p role="alert" className="mt-8 text-sm text-destructive">
          Unable to load this task: {message(selected.error)}
        </p>
      ) : null}
      {selectedTaskId && selected.data ? (
        <TaskDetail
          key={`${selected.data.id}:${selected.data.version}`}
          task={selected.data}
          comments={comments.data?.comments ?? []}
          dependencies={dependencies.data}
          archived={project?.project.status === "archived"}
          saving={update.isPending}
          moving={move.isPending}
          commenting={addComment.isPending}
          onUpdate={(input) => update.mutate({ id: selected.data!.id, input })}
          onMove={(status) =>
            move.mutate({
              id: selected.data!.id,
              status,
              version: selected.data!.version
            })
          }
          onComment={(body) =>
            addComment.mutate({ id: selected.data!.id, body })
          }
        />
      ) : null}
    </div>
  );
}

function CreateTaskForm({
  disabled,
  error,
  onCreate
}: {
  disabled: boolean;
  error: string | null;
  onCreate: (input: {
    title: string;
    description: string | null;
    priority: TaskPriority;
    status: HumanTaskStatus;
  }) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [status, setStatus] = useState<HumanTaskStatus>("backlog");
  return (
    <form
      className="mt-6 rounded border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) return;
        onCreate({
          title: title.trim(),
          description: description.trim() || null,
          priority,
          status
        });
        setTitle("");
        setDescription("");
      }}
      aria-labelledby="create-task-heading"
    >
      <h2 id="create-task-heading" className="text-sm font-semibold">
        Create task
      </h2>
      <div className="mt-3 grid gap-3 md:grid-cols-4 md:items-end">
        <div className="md:col-span-2">
          <Label htmlFor="task-title">Title</Label>
          <Input
            id="task-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={disabled}
            required
            className="mt-2"
          />
        </div>
        <div>
          <Label htmlFor="task-priority">Priority</Label>
          <select
            id="task-priority"
            value={priority}
            onChange={(event) =>
              setPriority(event.target.value as TaskPriority)
            }
            disabled={disabled}
            className="mt-2 h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
          >
            {priorities.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="task-status">Status</Label>
          <select
            id="task-status"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as HumanTaskStatus)
            }
            disabled={disabled}
            className="mt-2 h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
          >
            {statuses.map((item) => (
              <option key={item} value={item}>
                {item.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-3">
          <Label htmlFor="task-description">Description (Markdown)</Label>
          <textarea
            id="task-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={disabled}
            rows={3}
            className="mt-2 w-full rounded-lg border border-input bg-transparent p-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
        <Button type="submit" disabled={disabled || !title.trim()}>
          Create task
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function TaskDetail({
  task,
  comments,
  dependencies,
  archived,
  saving,
  moving,
  commenting,
  onUpdate,
  onMove,
  onComment
}: {
  task: Task;
  comments: Array<{
    id: string;
    body_markdown: string;
    created_at: string;
    author: { type: "human" | "agent"; full_name: string };
  }>;
  dependencies?: { depends_on: Task[]; blocks: Task[] };
  archived: boolean;
  saving: boolean;
  moving: boolean;
  commenting: boolean;
  onUpdate: (input: {
    title?: string;
    description?: string | null;
    priority?: TaskPriority;
    expected_version: number;
  }) => void;
  onMove: (status: HumanTaskStatus) => void;
  onComment: (body: string) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [comment, setComment] = useState("");
  const claimed = task.status === "claimed";
  return (
    <section
      className="mt-8 rounded border p-5"
      aria-labelledby="task-detail-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-muted-foreground">
            {task.key} · version {task.version}
          </p>
          <h2
            id="task-detail-heading"
            tabIndex={-1}
            className="mt-1 text-xl font-semibold"
          >
            {task.title}
          </h2>
        </div>
        {!claimed ? (
          <select
            aria-label="Move task status"
            value={task.status}
            disabled={archived || moving}
            onChange={(event) => onMove(event.target.value as HumanTaskStatus)}
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
          >
            {statuses.map((status) => (
              <option key={status} value={status}>
                {status.replace("_", " ")}
              </option>
            ))}
          </select>
        ) : (
          <p className="rounded bg-muted px-2 py-1 text-xs">
            Claimed by an agent
          </p>
        )}
      </div>
      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Priority</dt>
          <dd className="capitalize">{task.priority}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Created</dt>
          <dd>{new Date(task.created_at).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Updated</dt>
          <dd>{new Date(task.updated_at).toLocaleString()}</dd>
        </div>
      </dl>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor="detail-title">Title</Label>
          <Input
            id="detail-title"
            value={title}
            disabled={archived || claimed || saving}
            onChange={(event) => setTitle(event.target.value)}
            className="mt-2"
          />
          <Label htmlFor="detail-description" className="mt-4">
            Description (Markdown)
          </Label>
          <textarea
            id="detail-description"
            value={description}
            disabled={archived || claimed || saving}
            onChange={(event) => setDescription(event.target.value)}
            rows={5}
            className="mt-2 w-full rounded-lg border border-input bg-transparent p-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <Label htmlFor="detail-priority" className="mt-4">
            Priority
          </Label>
          <select
            id="detail-priority"
            value={priority}
            disabled={archived || claimed || saving}
            onChange={(event) =>
              setPriority(event.target.value as TaskPriority)
            }
            className="mt-2 h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
          >
            {priorities.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <Button
            className="mt-3"
            disabled={archived || claimed || saving || !title.trim()}
            onClick={() =>
              onUpdate({
                title: title.trim(),
                description: description || null,
                priority,
                expected_version: task.version
              })
            }
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
        <div>
          <h3 className="text-sm font-semibold">Dependencies</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Depends on:{" "}
            {dependencies?.depends_on.map((item) => item.key).join(", ") ||
              "None"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Blocks:{" "}
            {dependencies?.blocks.map((item) => item.key).join(", ") || "None"}
          </p>
          <h3 className="mt-5 text-sm font-semibold">Comments</h3>
          <div className="mt-2 space-y-2">
            {comments.length ? (
              comments.map((item) => (
                <p key={item.id} className="rounded bg-muted/50 p-2 text-sm">
                  <span className="font-medium">
                    {item.author.full_name}
                    {item.author.type === "agent" ? " (agent)" : ""}
                  </span>
                  : {item.body_markdown}
                </p>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No comments yet.</p>
            )}
          </div>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!comment.trim()) return;
              onComment(comment.trim());
              setComment("");
            }}
          >
            <Input
              aria-label="Add comment"
              value={comment}
              disabled={archived || commenting}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Add a Markdown comment"
            />
            <Button
              type="submit"
              variant="outline"
              disabled={archived || commenting || !comment.trim()}
            >
              {commenting ? "Commenting…" : "Comment"}
            </Button>
          </form>
        </div>
      </div>
    </section>
  );
}

function TaskMessage({
  title,
  message,
  onRetry
}: {
  title: string;
  message: string;
  onRetry?: () => unknown;
}) {
  return (
    <div
      className="mx-auto w-full max-w-3xl p-6 md:p-8"
      aria-labelledby="task-message-heading"
    >
      <h1
        id="task-message-heading"
        tabIndex={-1}
        className="text-2xl font-semibold"
      >
        {title}
      </h1>
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        {message}
      </p>
      {onRetry ? (
        <Button
          className="mt-5"
          variant="outline"
          onClick={() => void onRetry()}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}
