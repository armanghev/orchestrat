import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  NativeSelect,
  NativeSelectOption
} from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  documentsQueryOptions,
  tasksQueryOptions
} from "@/features/coordination/query-options";
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { useOptionalBranch } from "./branch-context";
import { branchKeys } from "./query-options";

type Choice = "blank" | "everything" | "pick";

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

// First visit to a new branch: start blank or bring work over from another
// branch. It sits above every page until the branch is set up; it is not a
// modal.
export function BranchOnboardingPanel({ api }: { api: ApiClient }) {
  const context = useOptionalBranch();
  const branch = context?.branch;
  const pending =
    Boolean(branch) &&
    branch?.onboarding_state === "pending" &&
    !context?.readOnly;
  return pending && context ? (
    <OnboardingPanel api={api} key={context.branchId} />
  ) : null;
}

function OnboardingPanel({ api }: { api: ApiClient }) {
  const queryClient = useQueryClient();
  const {
    projectId,
    branch,
    branchId,
    branches,
    defaultBranch,
    canManage,
    openImport
  } = useOptionalBranch()!;
  const sources = branches.filter((item) => item.id !== branchId);
  const [choice, setChoice] = useState<Choice>("blank");
  const [sourceId, setSourceId] = useState(
    defaultBranch && defaultBranch.id !== branchId
      ? defaultBranch.id
      : (sources[0]?.id ?? "")
  );
  const tasks = useQuery(tasksQueryOptions(api, projectId, branchId));
  const documents = useQuery(documentsQueryOptions(api, projectId, branchId));
  // Members can't import into the default branch.
  const canImport = sources.length > 0 && (canManage || !branch.is_default);
  const blank = useMutation({
    mutationFn: () => api.startBranchBlank(projectId, branchId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: branchKeys.project(projectId)
      })
  });
  const existing = [
    tasks.data?.tasks.length ? plural(tasks.data.tasks.length, "task") : null,
    documents.data?.documents.length
      ? plural(documents.data.documents.length, "document")
      : null
  ].filter(Boolean);
  const proceed = () => {
    if (choice === "blank" || !canImport) blank.mutate();
    else
      openImport({
        targetId: branchId,
        sourceId,
        lock: "target",
        preselect: choice === "everything" ? "all" : "none",
        completeOnboarding: true
      });
  };
  return (
    <Card
      className="m-4 mb-0 w-auto"
      role="region"
      aria-labelledby="branch-onboarding-title"
    >
      <CardHeader>
        <CardTitle>
          <h2 id="branch-onboarding-title">Set up {branch.name}</h2>
        </CardTitle>
        <CardDescription>
          Start this branch blank or bring work over from another branch.
          {existing.length
            ? ` ${existing.join(" and ")} already here will be kept.`
            : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RadioGroup
          aria-label={`How to set up ${branch.name}`}
          value={choice}
          onValueChange={(value) => setChoice(value as Choice)}
        >
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="blank" />
            Start blank
          </label>
          {canImport ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <RadioGroupItem value="everything" />
                  Import everything from
                </label>
                <NativeSelect
                  aria-label="Branch to import from"
                  value={sourceId}
                  onChange={(event) => {
                    setSourceId(event.target.value);
                    setChoice("everything");
                  }}
                >
                  {sources.map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {item.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="pick" />
                Pick items…
              </label>
            </>
          ) : null}
        </RadioGroup>
        {blank.isError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {blank.error instanceof DashboardApiError
              ? blank.error.message
              : "We couldn’t set up the branch. Try again."}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="justify-end">
        <Button type="button" disabled={blank.isPending} onClick={proceed}>
          {blank.isPending ? "Setting up…" : "Continue"}
        </Button>
      </CardFooter>
    </Card>
  );
}
