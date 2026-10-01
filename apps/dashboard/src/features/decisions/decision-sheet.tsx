import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  decisionSchema,
  type Decision,
  type MergeChoice
} from "@orchestrat/protocol";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { useBranch } from "@/features/branches/branch-context";
import { branchKeys } from "@/features/branches/query-options";
import { coordinationKeys } from "@/features/coordination/query-options";
import { messagingKeys } from "@/features/messaging/query-options";
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { decisionReasons } from "./decision-copy";

const valueText = (value: unknown) =>
  value === null || value === undefined
    ? "—"
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

const claimedNotice =
  "An agent is working on this task. You can choose once the claim ends.";

// One decision, source and target side by side (docs/project-branches.md
// §11.7). Owners and admins choose; members read.
export function DecisionSheet({
  api,
  projectId,
  decision: initial,
  onClose
}: {
  api: ApiClient;
  projectId: string;
  decision: Decision;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { branches, branchName, canManage } = useBranch();
  const [decision, setDecision] = useState(initial);
  const [stale, setStale] = useState(false);
  const sourceName = branchName(decision.source_branch_id) ?? "Source";
  const targetName = branchName(decision.target_branch_id) ?? "Target";
  const resolve = useMutation({
    mutationFn: (choice: MergeChoice) =>
      api.resolveDecision(projectId, decision.id, choice),
    onMutate: () => setStale(false),
    onSuccess: async () => {
      onClose();
      // The chosen values land on the target branch.
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: branchKeys.project(projectId)
        }),
        queryClient.invalidateQueries({
          queryKey: coordinationKeys.tasks(projectId, decision.target_branch_id)
        }),
        queryClient.invalidateQueries({
          queryKey: coordinationKeys.documents(
            projectId,
            decision.target_branch_id
          )
        }),
        queryClient.invalidateQueries({
          queryKey: messagingKeys.chats(projectId, decision.target_branch_id)
        })
      ]);
    },
    onError: (error) => {
      if (
        error instanceof DashboardApiError &&
        error.kind === "BRANCH_DECISION_STALE"
      ) {
        const refreshed = decisionSchema.safeParse(error.details.decision);
        if (refreshed.success) {
          setDecision(refreshed.data);
          // Nothing to review again once it's settled.
          setStale(refreshed.data.status === "open");
        }
        void queryClient.invalidateQueries({
          queryKey: branchKeys.project(projectId)
        });
      }
    }
  });
  const error = resolve.error;
  const apiError = error instanceof DashboardApiError ? error : undefined;
  // No dead buttons. A decision can be settled already (a stale response
  // returns it, or the API refuses with decision_closed) and an archived
  // target can't change; the footer says so instead.
  const settled =
    decision.status !== "open" ||
    (apiError?.kind === "CONFLICT" &&
      apiError.details.reason === "decision_closed");
  const targetArchived =
    apiError?.kind === "BRANCH_ARCHIVED" ||
    Boolean(
      branches.find((branch) => branch.id === decision.target_branch_id)
        ?.archived_at
    );
  const failure = apiError
    ? apiError.kind === "BRANCH_DECISION_STALE" || settled || targetArchived
      ? null
      : apiError.kind === "TASK_ALREADY_CLAIMED"
        ? claimedNotice
        : apiError.kind === "NETWORK_ERROR"
          ? "We couldn’t reach the Dashboard API. Check your connection and try again."
          : apiError.message
    : error
      ? "We couldn’t save your choice. Try again."
      : null;
  const fields = decision.fields.length
    ? decision.fields
    : Object.keys(decision.source_values);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !resolve.isPending) onClose();
      }}
    >
      <SheetContent
        className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        showCloseButton={!resolve.isPending}
      >
        <SheetHeader>
          <SheetTitle>{decision.label}</SheetTitle>
          <SheetDescription>
            {sourceName} → {targetName} · {decisionReasons[decision.reason]}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4">
          {stale ? (
            <Alert role="status">
              <AlertDescription>
                The target changed since this merge. Review again.
              </AlertDescription>
            </Alert>
          ) : null}
          {decision.reason === "target_claimed" ? (
            <Alert role="status">
              <AlertDescription>{claimedNotice}</AlertDescription>
            </Alert>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {targetName} keeps its version until someone chooses. Choosing{" "}
            {sourceName} copies its values over; choosing {targetName} keeps
            things as they are.
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <h3 className="font-medium">{sourceName}</h3>
            <h3 className="font-medium">{targetName}</h3>
            {fields.map((field) => (
              <div key={field} className="col-span-2 grid grid-cols-2 gap-x-3">
                <p className="col-span-2 text-xs text-muted-foreground">
                  {field}
                </p>
                <p className="rounded bg-muted/50 p-2 text-xs whitespace-pre-wrap break-words">
                  <span className="sr-only">{sourceName}: </span>
                  {valueText(decision.source_values[field])}
                </p>
                <p className="rounded bg-muted/50 p-2 text-xs whitespace-pre-wrap break-words">
                  <span className="sr-only">{targetName}: </span>
                  {valueText(decision.target_values[field])}
                </p>
              </div>
            ))}
          </div>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
        </div>
        <SheetFooter>
          {settled ? (
            <p role="status" className="text-sm text-muted-foreground">
              This decision is settled.
            </p>
          ) : targetArchived ? (
            <p role="status" className="text-sm text-muted-foreground">
              {targetName} is archived, so nothing can change there.
            </p>
          ) : canManage ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate("use_target")}
              >
                Use target ({targetName})
              </Button>
              <Button
                type="button"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate("use_source")}
              >
                Use source ({sourceName})
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Only project owners and admins can choose.
            </p>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
