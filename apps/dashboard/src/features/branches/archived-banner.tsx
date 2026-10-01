import type { Branch } from "@orchestrat/protocol";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  const { branch } = context;
  return (
    <Alert role="status" className="m-4 w-auto">
      <AlertDescription>
        <p>
          <strong className="font-medium text-foreground">
            {branch.name} is archived.
          </strong>{" "}
          {archivedReason(branch)} Its work is read-only.
        </p>
      </AlertDescription>
    </Alert>
  );
}
