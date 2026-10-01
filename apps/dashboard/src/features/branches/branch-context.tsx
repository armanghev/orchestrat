import { createContext, useContext, type ReactNode } from "react";
import type { Branch } from "@orchestrat/protocol";
import type { ImportRequest } from "./import-dialog";

// The branch a project page shows (docs/project-branches.md §11.1). The
// project layout resolves it once from `?branch=` and every page, the toolbar
// and the shell read it from here.
export type BranchContextValue = {
  projectId: string;
  /** Every branch, archived ones included: active first, default first. */
  branches: Branch[];
  branch: Branch;
  branchId: string;
  defaultBranch: Branch | null;
  projectArchived: boolean;
  branchArchived: boolean;
  /** An archived project or branch: write controls are hidden (§11.5). */
  readOnly: boolean;
  /** Owners and admins set the default, archive and merge (§6.6). */
  canManage: boolean;
  branchName: (branchId: string | null | undefined) => string | undefined;
  /** Shows another branch of this project, keeping the current page. */
  selectBranch: (branchId: string) => void;
  /** The `?branch=` value for a branch: none for the default. */
  branchParam: (branchId: string) => string | undefined;
  openCreateBranch: () => void;
  openAllBranches: () => void;
  /** Opens the import dialog (docs/project-branches.md §11.6). */
  openImport: (request: ImportRequest) => void;
};

const BranchContext = createContext<BranchContextValue | null>(null);

export function BranchProvider({
  value,
  children
}: {
  value: BranchContextValue;
  children: ReactNode;
}) {
  return (
    <BranchContext.Provider value={value}>{children}</BranchContext.Provider>
  );
}

export function useBranch() {
  const value = useContext(BranchContext);
  if (!value) throw new Error("useBranch must be used inside a project page.");
  return value;
}

/** For components that also render outside a project (the shell). */
export function useOptionalBranch() {
  return useContext(BranchContext);
}
