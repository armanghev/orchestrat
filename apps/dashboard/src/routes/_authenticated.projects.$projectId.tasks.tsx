import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Plus,
  Search,
  LayoutGrid,
  List,
  MessageSquare,
  ListTodo
} from "lucide-react";
import { PageState, StatusBadge } from "@/components/dashboard/page";
import { TopToolbarActions } from "@/components/app-shell/app-shell";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell
} from "@/components/ui/table";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  NativeSelect,
  NativeSelectOption
} from "@/components/ui/native-select";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon
} from "@/components/ui/input-group";
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
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
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
      setCreating(false);
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
  const filtered = tasks.data.tasks.filter(
    (task) =>
      (statusFilter === "all" || task.status === statusFilter) &&
      `${task.key} ${task.title}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
  );
  const grouped = boardStatuses
    .filter((status) => statusFilter === "all" || status === statusFilter)
    .map((status) => ({
      status,
      tasks: filtered.filter((task) => task.status === status)
    }));
  const archived = project?.project.status === "archived";
  const selectTask = (id: string) => {
    setSelectedTaskId(id);
    setNotice(null);
  };
  const emptyState = (
    <Empty className="min-h-72 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ListTodo />
        </EmptyMedia>
        <EmptyTitle>
          {tasks.data.tasks.length
            ? "No matching tasks"
            : "Your next project starts here"}
        </EmptyTitle>
        <EmptyDescription>
          {tasks.data.tasks.length
            ? "Try a different search or status filter."
            : "No tasks yet. Create your first task to get started."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
  return (
    <section className="dashboard-page" aria-label="Project tasks">
      <TopToolbarActions>
        <Button
          disabled={archived}
          onClick={() => {
            create.reset();
            setCreating(true);
          }}
        >
          <Plus data-icon="inline-start" />
          New task
        </Button>
      </TopToolbarActions>
      {archived ? (
        <Alert role="status">
          <AlertDescription>
            This project is archived and read-only.
          </AlertDescription>
        </Alert>
      ) : null}
      {notice && !selectedTaskId ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      <Tabs defaultValue="board" className="gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <TabsList aria-label="Task view">
            <TabsTrigger value="board">
              <LayoutGrid />
              Board
            </TabsTrigger>
            <TabsTrigger value="list">
              <List />
              List
            </TabsTrigger>
          </TabsList>
          <InputGroup className="w-full sm:ml-auto sm:w-60">
            <InputGroupInput
              aria-label="Search tasks"
              placeholder="Search tasks…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
          </InputGroup>
          <NativeSelect
            aria-label="Filter task status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <NativeSelectOption value="all">All statuses</NativeSelectOption>
            {boardStatuses.map((status) => (
              <NativeSelectOption key={status} value={status}>
                {status.replaceAll("_", " ")}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <span className="text-xs text-muted-foreground">
            {filtered.length} of {tasks.data.tasks.length} tasks
          </span>
        </div>

        <TabsContent value="board">
          {!filtered.length ? (
            emptyState
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {grouped.map(({ status, tasks: column }) => (
                  <section
                    key={status}
                    aria-labelledby={`status-${status}`}
                    className="min-w-0 rounded-xl bg-muted/50 p-3"
                  >
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h2
                        id={`status-${status}`}
                        className="text-sm font-medium capitalize"
                      >
                        {status.replaceAll("_", " ")}
                      </h2>
                      <Badge variant="outline">{column.length}</Badge>
                    </div>
                    <div className="flex min-h-24 flex-col gap-3">
                      {column.map((task) => (
                        <Card
                          size="sm"
                          key={task.id}
                          className="relative transition-shadow hover:ring-foreground/25"
                        >
                          <CardHeader>
                            <CardTitle>
                              <button
                                type="button"
                                onClick={() => selectTask(task.id)}
                                className="w-full text-left after:absolute after:inset-0"
                                aria-label={`${task.key} ${task.title}`}
                              >
                                <span className="block font-mono text-xs font-normal text-muted-foreground">
                                  {task.key}
                                </span>
                                <span className="mt-2 block text-sm font-medium leading-relaxed">
                                  {task.title}
                                </span>
                              </button>
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="flex items-center justify-between gap-2">
                            <Badge
                              variant={
                                task.priority === "urgent"
                                  ? "destructive"
                                  : "secondary"
                              }
                            >
                              {task.priority} priority
                            </Badge>
                            {task.comment_count > 0 ? (
                              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <MessageSquare className="size-3" />
                                {task.comment_count}
                              </span>
                            ) : null}
                          </CardContent>
                        </Card>
                      ))}
                      {!column.length ? (
                        <p className="py-6 text-center text-xs text-muted-foreground">
                          No tasks
                        </p>
                      ) : null}
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
        </TabsContent>
        <TabsContent value="list">
          {!filtered.length ? (
            emptyState
          ) : (
            <div className="overflow-hidden rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Task</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead className="text-right pr-4">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((task) => (
                    <TableRow key={task.id}>
                      <TableCell className="pl-4">
                        <button
                          className="flex flex-col gap-1 py-2 text-left"
                          onClick={() => selectTask(task.id)}
                        >
                          <span className="font-mono text-xs text-muted-foreground">
                            {task.key}
                          </span>
                          <span className="max-w-96 truncate font-medium">
                            {task.title}
                          </span>
                        </button>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={task.status} />
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            task.priority === "urgent"
                              ? "destructive"
                              : "outline"
                          }
                        >
                          {task.priority}
                        </Badge>
                      </TableCell>
                      <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                        {new Date(task.updated_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!create.isPending) setCreating(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create task</DialogTitle>
            <DialogDescription>
              Give your team a clear next step.
            </DialogDescription>
          </DialogHeader>
          <CreateTaskForm
            disabled={archived || create.isPending}
            error={create.error ? message(create.error) : null}
            onCreate={(input) => create.mutate(input)}
          />
        </DialogContent>
      </Dialog>
      <Sheet
        open={selectedTaskId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedTaskId(null);
        }}
      >
        <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Task details</SheetTitle>
            <SheetDescription>
              Review, update, and discuss this task.
            </SheetDescription>
          </SheetHeader>
          {notice ? (
            <Alert className="mx-4 w-auto">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : null}
          {selected.isPending ? (
            <p role="status" className="p-5 text-sm text-muted-foreground">
              Loading task details…
            </p>
          ) : null}
          {selected.isError ? (
            <Alert variant="destructive" className="mx-4 w-auto">
              <AlertDescription>
                Unable to load this task: {message(selected.error)}
              </AlertDescription>
            </Alert>
          ) : null}
          {selected.data ? (
            <TaskDetail
              key={`${selected.data.id}:${selected.data.version}`}
              task={selected.data}
              comments={comments.data?.comments ?? []}
              dependencies={dependencies.data}
              archived={archived}
              saving={update.isPending}
              moving={move.isPending}
              commenting={addComment.isPending}
              onUpdate={(input) =>
                update.mutate({ id: selected.data!.id, input })
              }
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
        </SheetContent>
      </Sheet>
    </section>
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
      className="mt-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) return;
        onCreate({
          title: title.trim(),
          description: description.trim() || null,
          priority,
          status
        });
      }}
      aria-label="Create task"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="task-title">Title</FieldLabel>
          <Input
            id="task-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={disabled}
            required
            maxLength={500}
            placeholder="What needs to be done?"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="task-description">
            Description (Markdown)
          </FieldLabel>
          <Textarea
            id="task-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={disabled}
            rows={4}
            placeholder="Add context, requirements, or a definition of done."
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="task-priority">Priority</FieldLabel>
            <NativeSelect
              id="task-priority"
              value={priority}
              onChange={(event) =>
                setPriority(event.target.value as TaskPriority)
              }
              disabled={disabled}
            >
              {priorities.map((item) => (
                <NativeSelectOption key={item} value={item}>
                  {item}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="task-status">Status</FieldLabel>
            <NativeSelect
              id="task-status"
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as HumanTaskStatus)
              }
              disabled={disabled}
            >
              {statuses.map((item) => (
                <NativeSelectOption key={item} value={item}>
                  {item.replaceAll("_", " ")}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          type="submit"
          disabled={disabled || !title.trim()}
          className="self-end"
        >
          {disabled ? "Creating…" : "Create task"}
        </Button>
      </FieldGroup>
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
    <section className="p-5 pt-0" aria-labelledby="task-detail-heading">
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
          <NativeSelect
            aria-label="Move task status"
            value={task.status}
            disabled={archived || moving}
            onChange={(event) => onMove(event.target.value as HumanTaskStatus)}
          >
            {statuses.map((status) => (
              <NativeSelectOption key={status} value={status}>
                {status.replace("_", " ")}
              </NativeSelectOption>
            ))}
          </NativeSelect>
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
          <Textarea
            id="detail-description"
            value={description}
            disabled={archived || claimed || saving}
            onChange={(event) => setDescription(event.target.value)}
            rows={5}
            className="mt-2"
          />
          <Label htmlFor="detail-priority" className="mt-4">
            Priority
          </Label>
          <NativeSelect
            id="detail-priority"
            value={priority}
            disabled={archived || claimed || saving}
            onChange={(event) =>
              setPriority(event.target.value as TaskPriority)
            }
            className="mt-2 w-full"
          >
            {priorities.map((item) => (
              <NativeSelectOption key={item} value={item}>
                {item}
              </NativeSelectOption>
            ))}
          </NativeSelect>
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
          <div className="mt-2 flex flex-col gap-2">
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
    <PageState
      title={title}
      message={message}
      error={Boolean(onRetry)}
      onRetry={onRetry}
    />
  );
}
