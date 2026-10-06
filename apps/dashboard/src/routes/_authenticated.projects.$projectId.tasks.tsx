import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
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
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { MarkdownContent } from "@/features/coordination/markdown-content";
import {
  invalidateAttentionQueries,
  overlaysByTask,
  taskAttentionQueryOptions
} from "@/features/attention/query-options";
import { TaskAttentionBadge } from "@/features/attention/task-attention-badge";
import {
  TaskAttentionPanel,
  TaskClaimLine
} from "@/features/attention/task-attention-panel";
import {
  BlockedCallout,
  BlockedTaskLine
} from "@/features/attention/blocked-callout";
import { PingDialog } from "@/features/attention/ping-dialog";
import { useBranch } from "@/features/branches/branch-context";
import { OtherBranchNotice } from "@/features/branches/other-branch-notice";
import type {
  HumanTaskStatus,
  ParticipantRef,
  Task,
  TaskAttentionOverlay,
  TaskComment,
  TaskPriority
} from "@orchestrat/protocol";

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/tasks"
)({
  validateSearch: z.object({ task: z.string().uuid().optional() }),
  component: TasksRoute
});
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
  const { task: selectedTaskId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { api } = Route.useRouteContext();
  const { branchId, branchParam, projectArchived, readOnly } = useBranch();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [notice, setNotice] = useState<string | null>(null);
  const tasks = useQuery(tasksQueryOptions(api, projectId, branchId));
  const taskId = selectedTaskId ?? "00000000-0000-4000-8000-000000000000";
  const selected = useQuery({
    ...taskQueryOptions(api, taskId),
    enabled: Boolean(selectedTaskId)
  });
  // A task deep link can name another branch's task (spec §11.1).
  const selectedBranchId = selected.data?.branch_id;
  const selectedInProject =
    selected.data?.project_id === projectId &&
    (selectedBranchId === undefined || selectedBranchId === branchId);
  const comments = useQuery({
    ...taskCommentsQueryOptions(api, taskId),
    enabled: selectedInProject
  });
  const dependencies = useQuery({
    ...taskDependenciesQueryOptions(api, taskId),
    enabled: selectedInProject
  });
  const attention = useQuery(taskAttentionQueryOptions(api, projectId));
  const overlays = overlaysByTask(attention.data?.tasks);
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
    }) => api.createTask(projectId, input, crypto.randomUUID(), { branchId }),
    onSuccess: async (task) => {
      setCreating(false);
      void navigate({ search: { task: task.id } });
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
    mutationFn: ({
      id,
      body,
      mentions
    }: {
      id: string;
      body: string;
      mentions: ParticipantRef[];
    }) =>
      api.createTaskComment(
        id,
        { body_markdown: body, mentions },
        crypto.randomUUID()
      ),
    onSuccess: async () => {
      setNotice(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: coordinationKeys.comments(taskId)
        }),
        invalidateAttentionQueries(queryClient, projectId)
      ]);
    },
    onError: (error) => setNotice(message(error))
  });
  const addDependency = useMutation({
    mutationFn: ({
      id,
      dependsOnTaskId,
      version
    }: {
      id: string;
      dependsOnTaskId: string;
      version: number;
    }) =>
      api.addTaskDependency(id, {
        depends_on_task_id: dependsOnTaskId,
        expected_version: version
      }),
    onSuccess: async (task) => {
      setNotice(null);
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({
          queryKey: coordinationKeys.task(task.id)
        }),
        queryClient.invalidateQueries({
          queryKey: coordinationKeys.dependencies(task.id)
        })
      ]);
    },
    onError: async (error) => {
      if (
        error instanceof DashboardApiError &&
        error.kind === "TASK_VERSION_CONFLICT"
      )
        await conflict();
      else if (
        error instanceof DashboardApiError &&
        error.kind === "TASK_DEPENDENCY_CYCLE"
      )
        setNotice("That dependency would create a cycle.");
      else setNotice(message(error));
    }
  });
  const removeDependency = useMutation({
    mutationFn: ({
      id,
      dependsOnTaskId,
      version
    }: {
      id: string;
      dependsOnTaskId: string;
      version: number;
    }) => api.removeTaskDependency(id, dependsOnTaskId, version),
    onSuccess: async (task) => {
      setNotice(null);
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({
          queryKey: coordinationKeys.task(task.id)
        }),
        queryClient.invalidateQueries({
          queryKey: coordinationKeys.dependencies(task.id)
        })
      ]);
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
  const selectTask = (id: string) => {
    setNotice(null);
    void navigate({ search: { task: id } });
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
      {!readOnly ? (
        <TopToolbarActions>
          <Button
            onClick={() => {
              create.reset();
              setCreating(true);
            }}
          >
            <Plus data-icon="inline-start" />
            New task
          </Button>
        </TopToolbarActions>
      ) : null}
      {projectArchived ? (
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
                            <OpenBlockLine overlay={overlays.get(task.id)} />
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
                            <span className="flex items-center gap-2">
                              <UnreadBadge overlay={overlays.get(task.id)} />
                              {task.comment_count > 0 ? (
                                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                  <MessageSquare className="size-3" />
                                  {task.comment_count}
                                </span>
                              ) : null}
                            </span>
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
                        <div className="flex items-center gap-3">
                          <div className="flex min-w-0 flex-col py-2">
                            <button
                              className="flex min-w-0 flex-col gap-1 text-left"
                              onClick={() => selectTask(task.id)}
                            >
                              <span className="font-mono text-xs text-muted-foreground">
                                {task.key}
                              </span>
                              <span className="max-w-96 truncate font-medium">
                                {task.title}
                              </span>
                            </button>
                            <OpenBlockLine
                              overlay={overlays.get(task.id)}
                              className="mt-1 max-w-96"
                            />
                          </div>
                          <UnreadBadge overlay={overlays.get(task.id)} />
                        </div>
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
            disabled={readOnly || create.isPending}
            error={create.error ? message(create.error) : null}
            onCreate={(input) => create.mutate(input)}
          />
        </DialogContent>
      </Dialog>
      <Sheet
        open={Boolean(selectedTaskId)}
        onOpenChange={(open) => {
          if (!open) void navigate({ search: {} });
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
          {selected.data &&
          selected.data.project_id === projectId &&
          selectedBranchId &&
          selectedBranchId !== branchId ? (
            <OtherBranchNotice
              item="task"
              branchId={selectedBranchId}
              className="mx-4"
              onSwitch={() =>
                void navigate({
                  search: (current) => ({
                    ...current,
                    branch: branchParam(selectedBranchId)
                  })
                })
              }
            />
          ) : selected.data && !selectedInProject ? (
            <Alert variant="destructive" className="mx-4 w-auto">
              <AlertDescription>
                This task belongs to a different project. Open it from that
                project's task list.
              </AlertDescription>
            </Alert>
          ) : null}
          {selected.data && selectedInProject ? (
            <TaskDetail
              key={selected.data.id}
              api={api}
              projectId={projectId}
              task={selected.data}
              attention={
                attention.isSuccess
                  ? (overlays.get(selected.data.id) ?? null)
                  : undefined
              }
              comments={comments.data?.comments ?? []}
              dependencies={dependencies.data}
              taskOptions={tasks.data.tasks}
              readOnly={readOnly}
              saving={update.isPending}
              moving={move.isPending}
              commenting={addComment.isPending}
              changingDependencies={
                addDependency.isPending || removeDependency.isPending
              }
              onUpdate={(input) =>
                update.mutateAsync({ id: selected.data!.id, input })
              }
              onMove={(status) =>
                move.mutate({
                  id: selected.data!.id,
                  status,
                  version: selected.data!.version
                })
              }
              onComment={(body, mentions) =>
                addComment.mutateAsync({
                  id: selected.data!.id,
                  body,
                  mentions
                })
              }
              onAddDependency={(dependsOnTaskId) =>
                addDependency.mutateAsync({
                  id: selected.data!.id,
                  dependsOnTaskId,
                  version: selected.data!.version
                })
              }
              onRemoveDependency={(dependsOnTaskId) =>
                removeDependency.mutateAsync({
                  id: selected.data!.id,
                  dependsOnTaskId,
                  version: selected.data!.version
                })
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
  api,
  projectId,
  task,
  attention,
  comments,
  dependencies,
  taskOptions,
  readOnly,
  saving,
  moving,
  commenting,
  changingDependencies,
  onUpdate,
  onMove,
  onComment,
  onAddDependency,
  onRemoveDependency
}: {
  api: ApiClient;
  projectId: string;
  task: Task;
  /** The viewer's overlay; undefined while it loads, null when absent. */
  attention: TaskAttentionOverlay | null | undefined;
  comments: TaskComment[];
  dependencies?: { depends_on: Task[]; blocks: Task[] };
  taskOptions: Task[];
  /** An archived project or branch: write controls are hidden. */
  readOnly: boolean;
  saving: boolean;
  moving: boolean;
  commenting: boolean;
  changingDependencies: boolean;
  onUpdate: (input: {
    title?: string;
    description?: string | null;
    priority?: TaskPriority;
    expected_version: number;
  }) => Promise<Task>;
  onMove: (status: HumanTaskStatus) => void;
  onComment: (body: string, mentions: ParticipantRef[]) => Promise<unknown>;
  onAddDependency: (dependsOnTaskId: string) => Promise<unknown>;
  onRemoveDependency: (dependsOnTaskId: string) => Promise<unknown>;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dependsOnTaskId, setDependsOnTaskId] = useState("");
  const [base, setBase] = useState(() => taskSnapshot(task));
  // An active claim locks the task whatever its status (agents may move a
  // claimed task to in_progress or blocked); status is the fallback while the
  // overlay loads.
  const claim = attention?.claim ?? null;
  const claimed =
    attention === undefined ? task.status === "claimed" : claim !== null;
  const dirty =
    title !== base.title ||
    description !== base.description ||
    priority !== base.priority;
  const staleDraft = dirty && task.version !== base.version;
  useEffect(() => {
    const next = taskSnapshot(task);
    if (next.id !== base.id || !dirty) {
      setTitle(next.title);
      setDescription(next.description);
      setPriority(next.priority);
      setBase(next);
      if (next.id !== base.id) setDependsOnTaskId("");
    }
  }, [base.id, dirty, task]);
  const existingDependencies = new Set(
    dependencies?.depends_on.map((item) => item.id) ?? []
  );
  const dependencyOptions = taskOptions.filter(
    (item) => item.id !== task.id && !existingDependencies.has(item.id)
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const block = attention?.block ?? null;
  const pingRecipient = claim
    ? { type: "agent" as const, id: claim.agent_id }
    : block?.blocked_on
      ? { type: block.blocked_on.type, id: block.blocked_on.id }
      : null;
  return (
    <section className="p-5 pt-0" aria-labelledby="task-detail-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-muted-foreground">
            {task.key} · version {task.version}
          </p>
          <h2
            ref={headingRef}
            id="task-detail-heading"
            tabIndex={-1}
            className="mt-1 text-xl font-semibold"
          >
            {task.title}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!claimed ? (
            readOnly ? (
              <StatusBadge status={task.status} />
            ) : (
              <NativeSelect
                aria-label="Move task status"
                value={task.status}
                disabled={moving}
                onChange={(event) =>
                  onMove(event.target.value as HumanTaskStatus)
                }
              >
                {statuses.map((status) => (
                  <NativeSelectOption key={status} value={status}>
                    {status.replace("_", " ")}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )
          ) : claim ? (
            <TaskClaimLine claim={claim} status={task.status} />
          ) : (
            <p className="rounded bg-muted px-2 py-1 text-xs">
              Claimed by an agent
            </p>
          )}
          {!readOnly ? (
            <PingDialog
              api={api}
              projectId={projectId}
              task={{ id: task.id, key: task.key, title: task.title }}
              defaultRecipient={pingRecipient}
            />
          ) : null}
        </div>
      </div>
      {block ? (
        <BlockedCallout
          api={api}
          projectId={projectId}
          taskKey={task.key}
          block={block}
          archived={readOnly}
          renderTaskLink={(blocking) => (
            <Link
              to="/projects/$projectId/tasks"
              params={{ projectId }}
              search={{ task: blocking.id }}
              className="underline underline-offset-4"
            >
              <span className="font-mono">{blocking.key}</span> {blocking.title}
            </Link>
          )}
          onResolved={() => headingRef.current?.focus()}
        />
      ) : null}
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
      {staleDraft ? (
        <Alert className="mt-5">
          <AlertDescription>
            This task changed on the server. Review the latest version before
            retrying.
            <details className="my-2">
              <summary className="cursor-pointer">
                Latest server version
              </summary>
              <p className="mt-2 font-medium">{task.title}</p>
              <p className="my-1 capitalize">Priority: {task.priority}</p>
              <MarkdownContent content={task.description} />
            </details>
            <span className="ml-3 inline-flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const next = taskSnapshot(task);
                  setTitle(next.title);
                  setDescription(next.description);
                  setPriority(next.priority);
                  setBase(next);
                }}
              >
                Use latest
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setBase(taskSnapshot(task))}
              >
                Keep my draft and retry
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {readOnly ? (
          <div>
            <h3 className="text-sm font-semibold">Description</h3>
            <div className="mt-2">
              {task.description ? (
                <MarkdownContent content={task.description} />
              ) : (
                <p className="text-sm text-muted-foreground">None</p>
              )}
            </div>
          </div>
        ) : (
          <div>
            <Label htmlFor="detail-title">Title</Label>
            <Input
              id="detail-title"
              value={title}
              disabled={claimed || saving}
              onChange={(event) => setTitle(event.target.value)}
              className="mt-2"
            />
            <Label htmlFor="detail-description" className="mt-4">
              Description (Markdown)
            </Label>
            <Textarea
              id="detail-description"
              value={description}
              disabled={claimed || saving}
              onChange={(event) => setDescription(event.target.value)}
              rows={5}
              className="mt-2"
            />
            <div className="mt-3 rounded-lg border bg-muted/30 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Preview
              </p>
              <MarkdownContent content={description} />
            </div>
            <Label htmlFor="detail-priority" className="mt-4">
              Priority
            </Label>
            <NativeSelect
              id="detail-priority"
              value={priority}
              disabled={claimed || saving}
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
              disabled={claimed || saving || !title.trim()}
              onClick={() => {
                void onUpdate({
                  title: title.trim(),
                  description: description || null,
                  priority,
                  expected_version: base.version
                })
                  .then((saved) => {
                    const next = taskSnapshot(saved);
                    setTitle(next.title);
                    setDescription(next.description);
                    setPriority(next.priority);
                    setBase(next);
                  })
                  .catch(() => undefined);
              }}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        )}
        <div>
          <h3 className="text-sm font-semibold">Dependencies</h3>
          <div className="mt-2 space-y-2">
            {dependencies?.depends_on.length ? (
              dependencies.depends_on.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-sm"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-xs text-muted-foreground">
                      {item.key}
                    </span>{" "}
                    {item.title}
                  </span>
                  {!readOnly ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={claimed || changingDependencies}
                      onClick={() => {
                        void onRemoveDependency(item.id).catch(() => undefined);
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">None</p>
            )}
          </div>
          {!readOnly ? (
            <div className="mt-3 flex gap-2">
              <NativeSelect
                aria-label="Add task dependency"
                value={dependsOnTaskId}
                disabled={
                  claimed || changingDependencies || !dependencyOptions.length
                }
                onChange={(event) => setDependsOnTaskId(event.target.value)}
              >
                <NativeSelectOption value="">
                  Add dependency…
                </NativeSelectOption>
                {dependencyOptions.map((item) => (
                  <NativeSelectOption key={item.id} value={item.id}>
                    {item.key} · {item.title}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Button
                type="button"
                variant="outline"
                disabled={claimed || changingDependencies || !dependsOnTaskId}
                onClick={() => {
                  void onAddDependency(dependsOnTaskId)
                    .then(() => setDependsOnTaskId(""))
                    .catch(() => undefined);
                }}
              >
                Add
              </Button>
            </div>
          ) : null}
          <p className="mt-1 text-sm text-muted-foreground">
            Blocks:{" "}
            {dependencies?.blocks.map((item) => item.key).join(", ") || "None"}
          </p>
          <TaskAttentionPanel
            api={api}
            projectId={projectId}
            taskId={task.id}
            comments={comments}
            archived={readOnly}
            commenting={commenting}
            onComment={onComment}
          />
        </div>
      </div>
    </section>
  );
}

function OpenBlockLine({
  overlay,
  className
}: {
  overlay?: TaskAttentionOverlay;
  className?: string;
}) {
  return overlay?.block ? (
    <BlockedTaskLine block={overlay.block} className={className} />
  ) : null;
}

function UnreadBadge({ overlay }: { overlay?: TaskAttentionOverlay }) {
  return overlay?.watching ? (
    <TaskAttentionBadge
      unread={overlay.unread_count}
      mentions={overlay.mention_count}
    />
  ) : null;
}

function taskSnapshot(task: Task) {
  return {
    id: task.id,
    version: task.version,
    title: task.title,
    description: task.description ?? "",
    priority: task.priority
  };
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
