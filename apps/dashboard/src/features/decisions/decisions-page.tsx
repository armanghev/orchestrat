import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import type { Decision, MergeRun } from "@orchestrat/protocol";
import { PageState } from "@/components/dashboard/page";
import { TopToolbarActions } from "@/components/app-shell/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from "@/components/ui/empty";
import { useBranch } from "@/features/branches/branch-context";
import { providerName } from "@/features/branches/merge-copy";
import {
  decisionsQueryOptions,
  mergeRunsQueryOptions
} from "@/features/branches/query-options";
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { decisionReasons } from "./decision-copy";
import { DecisionSheet } from "./decision-sheet";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

function MergeSource({ run }: { run: MergeRun | undefined }) {
  if (!run) return null;
  if (!run.provider) return <>Merged in Orchestrat</>;
  const label = `${run.provider.provider === "gitlab" ? "MR" : "PR"} #${run.provider.change_number ?? ""}`;
  return (
    <>
      {providerName(run.provider.provider)}{" "}
      {run.provider.change_url ? (
        <a
          href={run.provider.change_url}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4"
        >
          {label}
        </a>
      ) : (
        label
      )}
    </>
  );
}

// Decisions (docs/project-branches.md §11.7): the conflicts merges left for
// a person, filtered to the branch on screen as their target.
export function DecisionsPage({
  api,
  projectId
}: {
  api: ApiClient;
  projectId: string;
}) {
  const { branchId, branchName } = useBranch();
  const [allBranches, setAllBranches] = useState(false);
  const [open, setOpen] = useState<Decision | null>(null);
  const decisions = useQuery(
    decisionsQueryOptions(api, projectId, allBranches ? "all" : branchId)
  );
  const runs = useInfiniteQuery(mergeRunsQueryOptions(api, projectId));
  const runById = new Map(
    (runs.data?.pages ?? [])
      .flatMap((page) => page.runs)
      .map((run) => [run.id, run])
  );
  if (decisions.isPending)
    return <PageState title="Decisions" message="Loading decisions…" />;
  if (decisions.isError)
    return (
      <PageState
        error
        title="Decisions unavailable"
        message={
          decisions.error instanceof DashboardApiError &&
          decisions.error.kind === "PERMISSION_DENIED"
            ? "You don’t have permission to view decisions."
            : "We couldn’t load decisions. Check your connection and try again."
        }
        onRetry={() => decisions.refetch()}
      />
    );
  const items = decisions.data.decisions;
  const name = (id: string) => branchName(id) ?? "a removed branch";
  return (
    <section className="dashboard-page" aria-label="Decisions">
      <TopToolbarActions>
        <Badge variant="outline">{items.length} open</Badge>
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
      {items.length ? (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {items.map((decision) => (
            <li key={decision.id}>
              <button
                type="button"
                className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                onClick={() => setOpen(decision)}
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{decision.label}</span>
                  <time
                    dateTime={decision.created_at}
                    className="text-xs text-muted-foreground"
                  >
                    {dateFormat.format(new Date(decision.created_at))}
                  </time>
                </span>
                <span className="text-sm text-muted-foreground">
                  {name(decision.source_branch_id)} →{" "}
                  {name(decision.target_branch_id)} ·{" "}
                  {decisionReasons[decision.reason]}
                </span>
                {runById.get(decision.run_id) ? (
                  <span className="text-xs text-muted-foreground">
                    <MergeSource run={runById.get(decision.run_id)} />
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty className="min-h-72 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Scale />
            </EmptyMedia>
            <EmptyTitle>Nothing to decide</EmptyTitle>
            <EmptyDescription>
              {allBranches
                ? "Merges left no open decisions on any branch."
                : `Merges left no open decisions on ${name(branchId)}.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {open ? (
        <DecisionSheet
          key={open.id}
          api={api}
          projectId={projectId}
          decision={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </section>
  );
}
