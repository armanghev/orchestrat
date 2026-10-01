import type { Branch } from "@orchestrat/protocol";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useOptionalBranch } from "./branch-context";

const providerNames = {
  github: "GitHub",
  gitlab: "GitLab",
  origin: "Cursor Origin"
} as const;
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric"
});

/** Why a branch is archived, in plain words (docs/project-branches.md §11.5). */
export function archivedReason(branch: Branch) {
  const on = branch.archived_at
    ? ` on ${dayFormat.format(new Date(branch.archived_at))}`
    : "";
  if (branch.archived_reason === "provider_deleted")
    return `It was deleted on ${
      branch.provider ? providerNames[branch.provider.provider] : "the provider"
    }${on}.`;
  if (branch.archived_reason === "replaced_on_connect")
    return `It was replaced when the repository was connected${on}.`;
  return `It was archived${on}.`;
}

// Shell-level notice above every page of an archived branch. Pages hide their
// write controls through the branch context's readOnly flag.
export function ArchivedBranchBanner() {
  const context = useOptionalBranch();
  if (!context?.branchArchived) return null;
  const { branch, branches, canManage, projectArchived, defaultBranch } =
    context;
  // Its work can still move to an active branch (spec §11.5).
  const targets = branches.filter(
    (item) => !item.archived_at && (canManage || !item.is_default)
  );
  const target =
    targets.find((item) => item.id === defaultBranch?.id) ?? targets[0];
  return (
    <Alert role="status" className="m-4 w-auto">
      <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p>
          <strong className="font-medium text-foreground">
            {branch.name} is archived.
          </strong>{" "}
          {archivedReason(branch)} Its work is read-only.
        </p>
        {!projectArchived && target ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              context.openImport({
                sourceId: branch.id,
                targetId: target.id,
                lock: "source",
                preselect: "all"
              })
            }
          >
            Import into another branch
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
