import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  mergePreviewStaleDetailsSchema,
  type Branch,
  type MergePreview,
  type MergePreviewItem,
  type MergeRun
} from "@orchestrat/protocol";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption
} from "@/components/ui/native-select";
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { useBranch } from "./branch-context";
import { countLines, itemReasons, outcomeCount } from "./merge-copy";
import { branchKeys } from "./query-options";

export function mergeErrorMessage(error: unknown) {
  if (!(error instanceof DashboardApiError))
    return "We couldn’t merge. Try again.";
  if (error.kind === "BRANCH_ARCHIVED")
    return "The target branch is archived. Choose another branch.";
  if (error.kind === "PERMISSION_DENIED")
    return "Only project owners and admins can merge branches.";
  if (error.kind === "NETWORK_ERROR")
    return "We couldn’t reach the Dashboard API. Check your connection and try again.";
  return error.message;
}

function ItemList({
  items,
  label
}: {
  items: MergePreviewItem[];
  label: string;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium">
        {label} ({items.length})
      </h3>
      <ul className="flex max-h-40 flex-col divide-y overflow-auto rounded-lg border">
        {items.map((item) => (
          <li
            key={`${item.item_type}:${item.lineage_key}`}
            className="flex flex-col gap-0.5 px-3 py-2 text-sm"
          >
            <span className="min-w-0 truncate">
              {item.task_key ? (
                <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                  {item.task_key}
                </span>
              ) : null}
              {item.label}
            </span>
            {item.reason ? (
              <span className="text-xs text-muted-foreground">
                {itemReasons[item.reason]}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What a merge would change, in plain words. */
export function MergePreviewSummary({
  preview,
  sourceName,
  targetName
}: {
  preview: MergePreview;
  sourceName: string;
  targetName: string;
}) {
  const lines = countLines(preview.counts);
  const conflicts = preview.items.filter((item) => item.outcome === "conflict");
  const skipped = preview.items.filter((item) => item.outcome === "skipped");
  const unchanged = outcomeCount(preview.counts, "unchanged");
  return (
    <div className="flex flex-col gap-4">
      {lines.length ? (
        <ul className="list-disc pl-5 text-sm">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : !conflicts.length ? (
        <p className="text-sm text-muted-foreground">
          Nothing to merge. {targetName} already has everything from{" "}
          {sourceName}.
        </p>
      ) : null}
      {unchanged ? (
        <p className="text-sm text-muted-foreground">
          {unchanged}{" "}
          {unchanged === 1 ? "item already matches" : "items already match"}.
        </p>
      ) : null}
      {conflicts.length ? (
        <div className="flex flex-col gap-1.5">
          <ItemList items={conflicts} label="Will need your decision" />
          <p className="text-xs text-muted-foreground">
            {targetName} keeps its version of these until an owner or admin
            chooses on the Decisions page.
          </p>
        </div>
      ) : null}
      {skipped.length ? (
        <ItemList items={skipped} label="Won’t be merged" />
      ) : null}
    </div>
  );
}

// Merge… dialog: owners and admins pick a target, read the preview and confirm.
// Conflicts become decisions with the target kept; nothing touches Git.
export function MergeDialog({
  api,
  projectId,
  source,
  onClose
}: {
  api: ApiClient;
  projectId: string;
  source: Branch;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { branches, defaultBranch } = useBranch();
  const targets = branches.filter(
    (branch) => !branch.archived_at && branch.id !== source.id
  );
  const [targetId, setTargetId] = useState(
    defaultBranch && defaultBranch.id !== source.id
      ? defaultBranch.id
      : (targets[0]?.id ?? "")
  );
  // On by default unless the provider still tracks the source.
  const [archiveSource, setArchiveSource] = useState(
    !source.is_default && source.provider?.state !== "tracked"
  );
  const [refreshed, setRefreshed] = useState<MergePreview | null>(null);
  const [result, setResult] = useState<MergeRun | null>(null);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const target = targets.find((branch) => branch.id === targetId);
  const previewQuery = useQuery({
    queryKey: branchKeys.preview(projectId, "merge", source.id, targetId),
    queryFn: () =>
      api.previewMerge(projectId, {
        source_branch_id: source.id,
        target_branch_id: targetId,
        kind: "merge"
      }),
    enabled: Boolean(targetId) && !result,
    staleTime: 0,
    retry: false
  });
  const preview = refreshed ?? previewQuery.data;
  const merge = useMutation({
    mutationFn: (current: MergePreview) => {
      // Same preview, same key: a retry after a lost response can't merge
      // twice.
      if (attempt.current?.fingerprint !== current.fingerprint)
        attempt.current = {
          fingerprint: current.fingerprint,
          key: crypto.randomUUID()
        };
      return api.applyMerge(
        projectId,
        {
          source_branch_id: source.id,
          target_branch_id: targetId,
          kind: "merge",
          preview_fingerprint: current.fingerprint,
          archive_source: archiveSource && !source.is_default
        },
        attempt.current.key
      );
    },
    onSuccess: async (run) => {
      setResult(run);
      await queryClient.invalidateQueries({
        queryKey: branchKeys.project(projectId)
      });
    },
    onError: (error) => {
      if (
        error instanceof DashboardApiError &&
        error.kind === "BRANCH_PREVIEW_STALE"
      ) {
        const fresh = mergePreviewStaleDetailsSchema.safeParse(error.details);
        if (fresh.success) setRefreshed(fresh.data.preview);
      }
    }
  });
  const stale =
    merge.error instanceof DashboardApiError &&
    merge.error.kind === "BRANCH_PREVIEW_STALE";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !merge.isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={!merge.isPending}>
        <DialogHeader>
          <DialogTitle>Merge {source.name}</DialogTitle>
          <DialogDescription>
            Copies its tasks, documents and conversations into another branch.
            Nothing is deleted.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div role="status" className="flex flex-col gap-3 text-sm">
            <p className="font-medium">
              Merged {source.name} into {target?.name ?? "the target"}.
            </p>
            {countLines(result.counts).length ? (
              <ul className="list-disc pl-5">
                {countLines(result.counts).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
            {result.decision_count ? (
              <p>
                {result.decision_count}{" "}
                {result.decision_count === 1
                  ? "item needs your decision."
                  : "items need your decision."}
              </p>
            ) : null}
            {result.skipped.length ? (
              <p className="text-muted-foreground">
                {result.skipped.length} skipped:{" "}
                {result.skipped
                  .map((item) => `${item.label} (${itemReasons[item.reason]})`)
                  .join(", ")}
                .
              </p>
            ) : null}
            <p className="text-muted-foreground">
              Undo isn’t available; nothing was deleted.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="merge-target">Into</Label>
              <NativeSelect
                id="merge-target"
                className="w-full"
                value={targetId}
                disabled={merge.isPending}
                onChange={(event) => {
                  setTargetId(event.target.value);
                  setRefreshed(null);
                  merge.reset();
                }}
              >
                {targets.map((branch) => (
                  <NativeSelectOption key={branch.id} value={branch.id}>
                    {branch.name}
                    {branch.is_default ? " (default)" : ""}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div aria-live="polite" className="flex flex-col gap-3">
              {stale ? (
                <Alert role="status">
                  <AlertDescription>
                    Things changed while you were choosing. The preview is
                    refreshed; review it and merge again.
                  </AlertDescription>
                </Alert>
              ) : null}
              {!targets.length ? (
                <p className="text-sm text-muted-foreground">
                  There’s no other active branch to merge into.
                </p>
              ) : preview && target ? (
                <MergePreviewSummary
                  preview={preview}
                  sourceName={source.name}
                  targetName={target.name}
                />
              ) : previewQuery.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {mergeErrorMessage(previewQuery.error)}{" "}
                  <button
                    type="button"
                    className="font-medium underline"
                    onClick={() => void previewQuery.refetch()}
                  >
                    Retry
                  </button>
                </p>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  Checking what would change…
                </p>
              )}
            </div>
            {!source.is_default ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="merge-archive-source"
                  checked={archiveSource}
                  disabled={merge.isPending}
                  onCheckedChange={(checked) =>
                    setArchiveSource(checked === true)
                  }
                />
                <Label htmlFor="merge-archive-source" className="font-normal">
                  Archive {source.name} after merging
                </Label>
              </div>
            ) : null}
            {merge.isError && !stale ? (
              <p role="alert" className="text-sm text-destructive">
                {mergeErrorMessage(merge.error)}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {result ? (
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={merge.isPending}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!preview || !target || merge.isPending}
                onClick={() => preview && merge.mutate(preview)}
              >
                {merge.isPending ? "Merging…" : "Merge"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
