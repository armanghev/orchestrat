import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import {
  mergePreviewStaleDetailsSchema,
  type MergeChoice,
  type MergeItemType,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption
} from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { tasksQueryOptions } from "@/features/coordination/query-options";
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { useBranch } from "./branch-context";
import {
  carryChoices,
  emptySelection,
  isSelectable,
  pruneSelection,
  requiredBy,
  selectAll,
  selectionRequest,
  selectionSize,
  withRequiredTasks,
  type ImportSelection
} from "./import-selection";
import { countLines, itemReasons } from "./merge-copy";
import { branchKeys } from "./query-options";

/** Where an import goes and what is fixed. */
export type ImportRequest = {
  targetId: string;
  sourceId?: string;
  /** "target": importing into a branch, choose the source. "source":
   * moving an archived branch's work, choose the target. */
  lock: "target" | "source";
  preselect: "all" | "none";
  /** Onboarding: the import also finishes the target's setup. */
  completeOnboarding?: boolean;
};

const tabs: { type: MergeItemType; label: string }[] = [
  { type: "task", label: "Tasks" },
  { type: "document", label: "Documents" },
  { type: "chat", label: "Chats" }
];
const everything = { tasks: "all", documents: "all", chats: "all" } as const;

function useDebounced<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

function importErrorMessage(error: unknown) {
  if (!(error instanceof DashboardApiError))
    return "We couldn’t import. Try again.";
  if (error.kind === "BRANCH_ARCHIVED")
    return "That branch is archived, so nothing can be imported into it.";
  if (error.kind === "PERMISSION_DENIED")
    return "Only project owners and admins can import into the default branch.";
  if (error.kind === "NETWORK_ERROR")
    return "We couldn’t reach the Dashboard API. Check your connection and try again.";
  return error.message;
}

const valueText = (value: unknown) =>
  value === null || value === undefined
    ? "—"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

function ResponsiveDialog({
  title,
  description,
  footer,
  pending,
  onClose,
  children
}: {
  title: string;
  description: string;
  footer: ReactNode;
  pending: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  // A sheet on phones, a large dialog elsewhere.
  const isMobile = useIsMobile();
  const onOpenChange = (open: boolean) => {
    if (!open && !pending) onClose();
  };
  if (isMobile)
    return (
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[92dvh] overflow-y-auto"
          showCloseButton={!pending}
        >
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="px-4">{children}</div>
          <SheetFooter>{footer}</SheetFooter>
        </SheetContent>
      </Sheet>
    );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
        showCloseButton={!pending}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConflictRow({
  item,
  sourceName,
  targetName,
  choice,
  changed,
  disabled,
  onChoose
}: {
  item: MergePreviewItem;
  sourceName: string;
  targetName: string;
  choice: MergeChoice | undefined;
  changed: boolean;
  disabled: boolean;
  onChoose: (choice: MergeChoice) => void;
}) {
  const name = `${item.task_key ? `${item.task_key} ` : ""}${item.label}`;
  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-lg border px-3 py-2.5",
        changed && "border-warning bg-warning/5"
      )}
      data-changed={changed || undefined}
    >
      <div className="text-sm">
        <p className="font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">
          {item.reason ? itemReasons[item.reason] : "Changed on both branches"}
          {item.fields.length ? ` · Differs in ${item.fields.join(", ")}` : ""}
          {changed ? " · Changed since you looked" : ""}
        </p>
      </div>
      <RadioGroup
        aria-label={`Version to keep for ${name}`}
        className="flex flex-wrap gap-x-5 gap-y-2"
        value={choice ?? ""}
        disabled={disabled}
        onValueChange={(value) => onChoose(value as MergeChoice)}
      >
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem value="use_source" />
          Use source ({sourceName})
        </label>
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem value="use_target" />
          Use target ({targetName})
        </label>
      </RadioGroup>
      {item.fields.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium">
            Compare
          </summary>
          <dl className="mt-2 grid gap-2">
            {item.fields.map((field) => (
              <div
                key={field}
                className="grid gap-1 sm:grid-cols-[8rem_1fr_1fr]"
              >
                <dt className="text-xs text-muted-foreground">{field}</dt>
                <dd className="rounded bg-muted/50 p-2 text-xs whitespace-pre-wrap">
                  <span className="sr-only">{sourceName}: </span>
                  {valueText(item.source_values?.[field])}
                </dd>
                <dd className="rounded bg-muted/50 p-2 text-xs whitespace-pre-wrap">
                  <span className="sr-only">{targetName}: </span>
                  {valueText(item.target_values?.[field])}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </li>
  );
}

export function ImportDialog({
  api,
  projectId,
  request,
  onClose
}: {
  api: ApiClient;
  projectId: string;
  request: ImportRequest;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { branches, defaultBranch, canManage, branchName } = useBranch();
  const [targetId, setTargetId] = useState(request.targetId);
  const sources = branches.filter((branch) => branch.id !== targetId);
  const [sourceId, setSourceId] = useState(
    request.sourceId ??
      (defaultBranch && defaultBranch.id !== request.targetId
        ? defaultBranch.id
        : (sources[0]?.id ?? ""))
  );
  // Members can't import into the default branch.
  const targets = branches.filter(
    (branch) =>
      !branch.archived_at &&
      branch.id !== sourceId &&
      (canManage || !branch.is_default)
  );
  const sourceName = branchName(sourceId) ?? "source";
  const targetName = branchName(targetId) ?? "target";
  const [selection, setSelection] = useState<ImportSelection | null>(null);
  const [search, setSearch] = useState("");
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<MergeRun | null>(null);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  // The plan the person last saw, which their choices were made against.
  const seen = useRef<MergePreview | undefined>(undefined);
  const previewKey = branchKeys.preview(
    projectId,
    "import",
    sourceId,
    targetId
  );
  // A preview of everything lists what can be chosen and what each task
  // requires.
  const catalog = useQuery({
    queryKey: [...previewKey, "all"],
    queryFn: () =>
      api.previewMerge(projectId, {
        source_branch_id: sourceId,
        target_branch_id: targetId,
        kind: "import",
        selection: everything
      }),
    enabled: Boolean(sourceId && targetId) && !result,
    retry: false
  });
  const items = useMemo(() => catalog.data?.items ?? [], [catalog.data]);
  const sourceTasks = useQuery({
    ...tasksQueryOptions(api, projectId, sourceId),
    enabled: Boolean(sourceId)
  });
  const statusBySourceId = new Map(
    (sourceTasks.data?.tasks ?? []).map((task) => [task.id, task.status])
  );
  useEffect(() => {
    if (!catalog.data) return;
    setSelection((current) =>
      current
        ? pruneSelection(current, catalog.data.items)
        : request.preselect === "all"
          ? selectAll(catalog.data.items)
          : emptySelection()
    );
  }, [catalog.data, request.preselect]);
  const chosen = selection ?? emptySelection();
  const includedTasks = withRequiredTasks(items, chosen.task);
  const keyOf = new Map(
    items
      .filter((item) => item.item_type === "task")
      .map((item) => [item.lineage_key, item.task_key ?? item.label])
  );
  const roots = selectionRequest(chosen);
  const rootsKey = JSON.stringify(roots);
  const debouncedKey = useDebounced(rootsKey, 250);
  const nothingChosen = selectionSize(chosen) === 0;
  // The exact plan for this selection: its conflicts and its fingerprint.
  const planKey = [...previewKey, debouncedKey];
  const plan = useQuery({
    queryKey: planKey,
    queryFn: () =>
      api.previewMerge(projectId, {
        source_branch_id: sourceId,
        target_branch_id: targetId,
        kind: "import",
        selection: JSON.parse(debouncedKey) as ReturnType<
          typeof selectionRequest
        >
      }),
    enabled:
      Boolean(selection) &&
      !nothingChosen &&
      debouncedKey === rootsKey &&
      !result,
    placeholderData: keepPreviousData,
    retry: false
  });
  const current =
    plan.data && !plan.isPlaceholderData && debouncedKey === rootsKey
      ? plan.data
      : undefined;
  // The plan changes without asking: realtime events refetch it, a new
  // selection replaces it and a stale import returns a fresh one. Whenever
  // its fingerprint changes, choices carry over from the plan the person last
  // saw: unchanged conflicts keep theirs, changed ones are cleared and
  // highlighted, new ones have none yet. A layout effect, so Import never
  // paints enabled with a choice made against old values.
  useLayoutEffect(() => {
    if (!current) return;
    const before = seen.current;
    seen.current = current;
    if (!before || before.fingerprint === current.fingerprint) return;
    const carried = carryChoices(before, current, choices);
    const stillConflicts = new Set(
      current.items
        .filter((item) => item.outcome === "conflict")
        .map((item) => item.lineage_key)
    );
    setChoices(carried.choices);
    // An earlier highlight stays until its conflict gets a choice.
    setChanged(
      (previous) =>
        new Set([
          ...carried.changed,
          ...[...previous].filter(
            (key) => stillConflicts.has(key) && !carried.choices[key]
          )
        ])
    );
    // Only a new plan runs this, reading `choices` as of that render.
  }, [current]);
  const conflicts = (current ?? plan.data)?.items.filter(
    (item) => item.outcome === "conflict"
  );
  const unchosen = (current?.items ?? []).filter(
    (item) => item.outcome === "conflict" && !choices[item.lineage_key]
  ).length;
  const apply = useMutation({
    mutationFn: (preview: MergePreview) => {
      if (attempt.current?.fingerprint !== preview.fingerprint)
        attempt.current = {
          fingerprint: preview.fingerprint,
          key: crypto.randomUUID()
        };
      const conflictKeys = preview.items
        .filter((item) => item.outcome === "conflict")
        .map((item) => item.lineage_key);
      return api.applyMerge(
        projectId,
        {
          source_branch_id: sourceId,
          target_branch_id: targetId,
          kind: "import",
          selection: roots,
          choices: Object.fromEntries(
            conflictKeys.map((key) => [key, choices[key]!])
          ),
          preview_fingerprint: preview.fingerprint,
          complete_onboarding: request.completeOnboarding ?? false
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
        !(error instanceof DashboardApiError) ||
        error.kind !== "BRANCH_PREVIEW_STALE"
      )
        return;
      const fresh = mergePreviewStaleDetailsSchema.safeParse(error.details);
      if (!fresh.success) return;
      // The fresh plan replaces the old one. Selections stay, and choices
      // carry over like on any other change of plan.
      queryClient.setQueryData(planKey, fresh.data.preview);
      void catalog.refetch();
    }
  });
  const stale =
    apply.error instanceof DashboardApiError &&
    apply.error.kind === "BRANCH_PREVIEW_STALE";
  const choose = (key: string, choice: MergeChoice) => {
    setChoices((previous) => ({ ...previous, [key]: choice }));
    setChanged((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  };
  const chooseAll = (choice: MergeChoice) =>
    setChoices((previous) => ({
      ...previous,
      ...Object.fromEntries(
        (conflicts ?? []).map((item) => [item.lineage_key, choice])
      )
    }));
  const toggle = (type: MergeItemType, keys: string[], on: boolean) =>
    setSelection((previous) => {
      const next = { ...(previous ?? emptySelection()) };
      const set = new Set(next[type]);
      for (const key of keys) {
        if (on) set.add(key);
        else set.delete(key);
      }
      next[type] = set;
      return next;
    });
  const reset = (next: { sourceId?: string; targetId?: string }) => {
    if (next.sourceId) setSourceId(next.sourceId);
    if (next.targetId) setTargetId(next.targetId);
    setSelection(null);
    setChoices({});
    setChanged(new Set());
    // Another pair of branches: nothing carries over from its plans.
    seen.current = undefined;
    apply.reset();
  };
  const pending = apply.isPending;
  const canApply =
    Boolean(current) && !nothingChosen && unchosen === 0 && !pending;

  const footer = result ? (
    <Button type="button" onClick={onClose}>
      Done
    </Button>
  ) : (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={onClose}
      >
        Cancel
      </Button>
      <Button
        type="button"
        disabled={!canApply}
        onClick={() => current && apply.mutate(current)}
      >
        {pending ? "Importing…" : "Import"}
      </Button>
    </>
  );

  const list = (type: MergeItemType) => {
    const ofType = items.filter((item) => item.item_type === type);
    const term = search.trim().toLowerCase();
    const shown = ofType.filter((item) =>
      `${item.task_key ?? ""} ${item.label}`.toLowerCase().includes(term)
    );
    const choosable = shown.filter(isSelectable);
    const checked = (item: MergePreviewItem) =>
      type === "task"
        ? includedTasks.has(item.lineage_key)
        : chosen[type].has(item.lineage_key);
    const allChecked =
      choosable.length > 0 && choosable.every((item) => checked(item));
    return (
      <div className="flex flex-col gap-2">
        {choosable.length ? (
          <label className="flex items-center gap-2 px-1 text-sm">
            <Checkbox
              checked={allChecked}
              disabled={pending}
              onCheckedChange={(on) =>
                toggle(
                  type,
                  choosable.map((item) => item.lineage_key),
                  on === true
                )
              }
            />
            Select all
          </label>
        ) : null}
        {shown.length ? (
          <ul className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-lg border">
            {shown.map((item) => {
              const lockedBy =
                type === "task" ? requiredBy(item, includedTasks) : [];
              const locked =
                lockedBy.length > 0 && !chosen.task.has(item.lineage_key);
              const disabled = !isSelectable(item) || locked;
              const status =
                type === "task"
                  ? statusBySourceId.get(item.source_id)?.replaceAll("_", " ")
                  : undefined;
              const notes = [
                status,
                item.audience
                  ? `Visible to ${item.audience.map((member) => member.name).join(", ") || "nobody yet"}`
                  : undefined,
                lockedBy.length
                  ? `Required by ${lockedBy.map((key) => keyOf.get(key) ?? "another task").join(", ")}`
                  : undefined,
                item.outcome === "unchanged"
                  ? `Already in ${targetName}`
                  : item.outcome === "keep_target"
                    ? `${targetName} has the newer version`
                    : item.outcome === "skipped" && item.reason
                      ? itemReasons[item.reason]
                      : item.outcome === "apply"
                        ? `Updates ${targetName}’s copy`
                        : undefined
              ].filter(Boolean);
              return (
                <li key={item.lineage_key}>
                  <label
                    className={cn(
                      "flex items-start gap-3 px-3 py-2 text-sm",
                      disabled && "text-muted-foreground"
                    )}
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={checked(item)}
                      disabled={disabled || pending}
                      onCheckedChange={(on) =>
                        toggle(type, [item.lineage_key], on === true)
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {item.task_key ? (
                          <span className="mr-1.5 font-mono text-xs">
                            {item.task_key}
                          </span>
                        ) : null}
                        {item.label}
                      </span>
                      {notes.length ? (
                        <span className="block text-xs text-muted-foreground">
                          {notes.join(" · ")}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-1 py-4 text-sm text-muted-foreground">
            {ofType.length
              ? "Nothing matches your search."
              : `${sourceName} has none.`}
          </p>
        )}
      </div>
    );
  };

  return (
    <ResponsiveDialog
      title={`Import into ${targetName}`}
      description="Copies the items you choose. Nothing is deleted, and the source keeps its copies."
      footer={footer}
      pending={pending}
      onClose={onClose}
    >
      {result ? (
        <div role="status" className="flex flex-col gap-3 text-sm">
          <p className="font-medium">
            Imported into {targetName} from {sourceName}.
          </p>
          {countLines(result.counts).length ? (
            <ul className="list-disc pl-5">
              {countLines(result.counts).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p>Nothing new to copy.</p>
          )}
          {result.skipped.length ? (
            <div>
              <p>Skipped:</p>
              <ul className="list-disc pl-5 text-muted-foreground">
                {result.skipped.map((item) => (
                  <li key={item.lineage_key}>
                    {item.label}: {itemReasons[item.reason]}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-muted-foreground">
            Undo isn’t available; nothing was deleted.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="import-source">From</Label>
              {request.lock === "target" ? (
                <NativeSelect
                  id="import-source"
                  className="w-full"
                  value={sourceId}
                  disabled={pending}
                  onChange={(event) => reset({ sourceId: event.target.value })}
                >
                  {sources.map((branch) => (
                    <NativeSelectOption key={branch.id} value={branch.id}>
                      {branch.name}
                      {branch.archived_at ? " (archived)" : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <p id="import-source" className="text-sm font-medium">
                  {sourceName}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="import-target">Into</Label>
              {request.lock === "source" ? (
                <NativeSelect
                  id="import-target"
                  className="w-full"
                  value={targetId}
                  disabled={pending}
                  onChange={(event) => reset({ targetId: event.target.value })}
                >
                  {targets.map((branch) => (
                    <NativeSelectOption key={branch.id} value={branch.id}>
                      {branch.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <p id="import-target" className="text-sm font-medium">
                  {targetName}
                </p>
              )}
            </div>
          </div>
          {stale ? (
            <Alert role="status">
              <AlertDescription>
                Things changed while you were choosing. The preview is refreshed
                and your selections were kept.
              </AlertDescription>
            </Alert>
          ) : null}
          {catalog.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {importErrorMessage(catalog.error)}{" "}
              <button
                type="button"
                className="font-medium underline"
                onClick={() => void catalog.refetch()}
              >
                Retry
              </button>
            </p>
          ) : !catalog.data || !selection ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading what {sourceName} has…
            </p>
          ) : (
            <>
              {/* Locked while importing: the request went out with this
                  selection and these choices. */}
              <Input
                type="search"
                aria-label="Search items"
                placeholder="Search items"
                value={search}
                disabled={pending}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Tabs defaultValue="task" className="gap-3">
                <TabsList aria-label="Item types">
                  {tabs.map(({ type, label }) => (
                    <TabsTrigger key={type} value={type}>
                      {label} (
                      {type === "task" ? includedTasks.size : chosen[type].size}
                      )
                    </TabsTrigger>
                  ))}
                </TabsList>
                {tabs.map(({ type }) => (
                  <TabsContent key={type} value={type}>
                    {list(type)}
                  </TabsContent>
                ))}
              </Tabs>
              <section
                aria-label="Conflicts"
                aria-live="polite"
                className="flex flex-col gap-2"
              >
                {nothingChosen ? (
                  <p className="text-sm text-muted-foreground">
                    Choose what to import.
                  </p>
                ) : !conflicts ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Checking for conflicts…
                  </p>
                ) : conflicts.length ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-medium">
                        Conflicts ({conflicts.length})
                      </h3>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={pending}
                          onClick={() => chooseAll("use_target")}
                        >
                          Use target for all
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={pending}
                          onClick={() => chooseAll("use_source")}
                        >
                          Use source for all
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Both branches changed these. Choose which version to keep
                      for each; nothing is chosen for you.
                    </p>
                    <ul className="flex flex-col gap-2">
                      {conflicts.map((item) => (
                        <ConflictRow
                          key={item.lineage_key}
                          item={item}
                          sourceName={sourceName}
                          targetName={targetName}
                          choice={choices[item.lineage_key]}
                          changed={changed.has(item.lineage_key)}
                          disabled={pending}
                          onChoose={(choice) =>
                            choose(item.lineage_key, choice)
                          }
                        />
                      ))}
                    </ul>
                    {unchosen ? (
                      <p className="text-xs text-muted-foreground">
                        Choose a version for {unchosen} more{" "}
                        {unchosen === 1 ? "conflict" : "conflicts"} to import.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No conflicts.</p>
                )}
              </section>
              {apply.isError && !stale ? (
                <p role="alert" className="text-sm text-destructive">
                  {importErrorMessage(apply.error)}
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
    </ResponsiveDialog>
  );
}
