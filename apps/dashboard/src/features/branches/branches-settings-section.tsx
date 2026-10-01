import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontal, Plus } from "lucide-react";
import type { Branch, MergeRun } from "@orchestrat/protocol";
import { StatusBadge } from "@/components/dashboard/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { useBranch } from "./branch-context";
import { branchSource, countLines, providerName } from "./merge-copy";
import { MergeDialog } from "./merge-dialog";
import { branchKeys, mergeRunsQueryOptions } from "./query-options";

type Confirmation = { kind: "default" | "archive"; branch: Branch };

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

function actionError(error: unknown) {
  if (!(error instanceof DashboardApiError))
    return "That didn’t work. Try again.";
  if (error.kind === "PERMISSION_DENIED")
    return "Only project owners and admins can change branches.";
  if (error.kind === "BRANCH_ARCHIVED")
    return "This branch is archived. Archived branches can’t become the default.";
  if (error.kind === "NETWORK_ERROR")
    return "We couldn’t reach the Dashboard API. Check your connection and try again.";
  return error.message;
}

function MergeHistory({
  api,
  projectId
}: {
  api: ApiClient;
  projectId: string;
}) {
  const { branchName } = useBranch();
  const runs = useInfiniteQuery(mergeRunsQueryOptions(api, projectId));
  if (runs.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading merge history…
      </p>
    );
  if (runs.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        We couldn’t load merge history.{" "}
        <button
          type="button"
          className="font-medium underline"
          onClick={() => void runs.refetch()}
        >
          Retry
        </button>
      </p>
    );
  const items = runs.data.pages.flatMap((page) => page.runs);
  if (!items.length)
    return (
      <p className="text-sm text-muted-foreground">No imports or merges yet.</p>
    );
  const name = (id: string) => branchName(id) ?? "a removed branch";
  const describe = (run: MergeRun) => {
    if (run.status === "skipped")
      return run.skip_reason === "fork"
        ? "Skipped: the change came from a fork."
        : run.skip_reason === "no_source_branch"
          ? "Skipped: the source branch isn’t in Orchestrat."
          : run.skip_reason === "same_branch"
            ? "Skipped: source and target are the same branch."
            : "Skipped: the source had nothing to merge.";
    if (run.status === "failed") return "Failed. Nothing was changed.";
    const lines = countLines(run.counts);
    return [
      lines.length ? lines.join(", ") : "Nothing new",
      run.decision_count
        ? `${run.decision_count} ${run.decision_count === 1 ? "decision" : "decisions"}`
        : null
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col divide-y rounded-lg border">
        {items.map((run) => (
          <li key={run.id} className="flex flex-col gap-1 px-3 py-2.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">
                {run.kind === "import" ? "Import" : "Merge"}{" "}
                {name(run.source_branch_id)} → {name(run.target_branch_id)}
              </p>
              <time
                dateTime={run.created_at}
                className="text-xs text-muted-foreground"
              >
                {dateFormat.format(new Date(run.created_at))}
              </time>
            </div>
            <p className="text-xs text-muted-foreground">
              {run.provider ? (
                <>
                  {providerName(run.provider.provider)}{" "}
                  {run.provider.change_url ? (
                    <a
                      href={run.provider.change_url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      {run.provider.provider === "gitlab" ? "MR" : "PR"} #
                      {run.provider.change_number}
                    </a>
                  ) : run.provider.change_number ? (
                    `#${run.provider.change_number}`
                  ) : null}{" "}
                  ·{" "}
                </>
              ) : null}
              {describe(run)}
            </p>
          </li>
        ))}
      </ol>
      {runs.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={runs.isFetchingNextPage}
          onClick={() => void runs.fetchNextPage()}
        >
          {runs.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}

// Settings › Branches (docs/project-branches.md §11.8). Everyone sees the
// table and history; owners and admins also set the default, merge and
// archive.
export function BranchesSettingsSection({
  api,
  projectId
}: {
  api: ApiClient;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const {
    branches,
    branch: current,
    defaultBranch,
    canManage,
    projectArchived,
    openCreateBranch
  } = useBranch();
  const [showArchived, setShowArchived] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [mergeSource, setMergeSource] = useState<Branch | null>(null);
  const action = useMutation({
    mutationFn: ({ kind, branch }: Confirmation) =>
      kind === "default"
        ? api.setDefaultBranch(projectId, branch.id)
        : api.archiveBranch(projectId, branch.id),
    onSuccess: async (_, { kind }) => {
      setConfirmation(null);
      // Without ?branch= a page shows the default, so stay on the branch
      // on screen when the default moves.
      if (kind === "default" && current.id === defaultBranch?.id)
        await navigate({
          to: "/projects/$projectId/settings",
          params: { projectId },
          search: { branch: current.id },
          hash: "branches"
        });
      await queryClient.invalidateQueries({
        queryKey: branchKeys.project(projectId)
      });
    }
  });
  const active = branches.filter((branch) => !branch.archived_at);
  const visible = showArchived ? branches : active;
  const confirm = (next: Confirmation) => {
    action.reset();
    setConfirmation(next);
  };
  return (
    <Card id="branches" className="scroll-mt-4">
      <CardHeader>
        <CardTitle>
          <h2>Branches</h2>
        </CardTitle>
        <CardDescription>
          Each branch keeps its own tasks, documents and conversations. Agents
          join the branch that matches their Git branch.
        </CardDescription>
        {!projectArchived ? (
          <CardAction>
            <Button type="button" variant="outline" onClick={openCreateBranch}>
              <Plus data-icon="inline-start" />
              New branch
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="branches" className="gap-4">
          <TabsList aria-label="Branch views">
            <TabsTrigger value="branches">Branches</TabsTrigger>
            <TabsTrigger value="history">Merge history</TabsTrigger>
          </TabsList>
          <TabsContent value="branches" className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="branches-show-archived"
                checked={showArchived}
                onCheckedChange={(checked) => setShowArchived(checked === true)}
              />
              <Label htmlFor="branches-show-archived" className="font-normal">
                Show archived ({branches.length - active.length})
              </Label>
            </div>
            {/* Source and last activity hide on phones so the table never
                scrolls sideways. */}
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-3">Branch</TableHead>
                    <TableHead className="hidden sm:table-cell">
                      Source
                    </TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden sm:table-cell">
                      Last activity
                    </TableHead>
                    <TableHead className="w-12 pr-3">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((branch) => {
                    const archived = Boolean(branch.archived_at);
                    const canDefault =
                      canManage && !branch.is_default && !archived;
                    const canMerge =
                      canManage && !archived && active.length > 1;
                    const canArchive =
                      canManage && !branch.is_default && !archived;
                    return (
                      <TableRow key={branch.id}>
                        <TableCell className="pl-3">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="max-w-40 truncate font-medium sm:max-w-none">
                              {branch.name}
                            </span>
                            {branch.is_default ? (
                              <Badge variant="outline">Default</Badge>
                            ) : null}
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground sm:table-cell">
                          {branchSource(branch)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            status={archived ? "archived" : "active"}
                          />
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground sm:table-cell">
                          <time dateTime={branch.updated_at}>
                            {dateFormat.format(new Date(branch.updated_at))}
                          </time>
                        </TableCell>
                        <TableCell className="pr-3 text-right">
                          {canDefault || canMerge || canArchive ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Actions for ${branch.name}`}
                                >
                                  <MoreHorizontal aria-hidden="true" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {canDefault ? (
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      confirm({ kind: "default", branch })
                                    }
                                  >
                                    Set as default
                                  </DropdownMenuItem>
                                ) : null}
                                {canMerge ? (
                                  <DropdownMenuItem
                                    onSelect={() => setMergeSource(branch)}
                                  >
                                    Merge into…
                                  </DropdownMenuItem>
                                ) : null}
                                {canArchive ? (
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      confirm({ kind: "archive", branch })
                                    }
                                  >
                                    Archive
                                  </DropdownMenuItem>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
          <TabsContent value="history">
            <MergeHistory api={api} projectId={projectId} />
          </TabsContent>
        </Tabs>
      </CardContent>
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !action.isPending) setConfirmation(null);
        }}
      >
        {confirmation ? (
          <DialogContent showCloseButton={!action.isPending}>
            <DialogHeader>
              <DialogTitle>
                {confirmation.kind === "default"
                  ? `Make ${confirmation.branch.name} the default branch?`
                  : `Archive ${confirmation.branch.name}?`}
              </DialogTitle>
              <DialogDescription>
                {confirmation.kind === "default"
                  ? `Agents and tools that don’t name a branch, including older CLI versions, will read and write there.${defaultBranch ? ` ${defaultBranch.name} stays as a regular branch.` : ""}`
                  : "It becomes read-only and hidden. Nothing is deleted. Active agent sessions on it will be closed."}
              </DialogDescription>
            </DialogHeader>
            {action.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {actionError(action.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={action.isPending}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={action.isPending}
                onClick={() => action.mutate(confirmation)}
              >
                {action.isPending
                  ? "Saving…"
                  : confirmation.kind === "default"
                    ? "Make default"
                    : "Archive branch"}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
      {mergeSource ? (
        <MergeDialog
          api={api}
          projectId={projectId}
          source={mergeSource}
          onClose={() => setMergeSource(null)}
        />
      ) : null}
    </Card>
  );
}
