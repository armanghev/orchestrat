import { z } from "zod";

// Project branch contracts (docs/project-branches.md §4, §6). Like attention.ts,
// this module imports only zod: index.ts re-exports it with `export *`, so a
// back-reference to index.ts primitives would hit a TDZ error. The primitives
// below mirror index.ts deliberately.
const idSchema = z.string().uuid();
const dateSchema = z.string().datetime();
const booleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

/** Request header an agent uses to name a branch (spec §6.1). */
export const BRANCH_ID_HEADER = "x-orchestrat-branch-id";
/** Request header that pins an agent request to its open session (spec §6.1). */
export const SESSION_ID_HEADER = "x-orchestrat-session-id";

// New codes are only returned to requests that carried an explicit branch
// signal or that hit branch-only routes, so old clients with a closed error
// enum never see them (spec §6.4).
export const branchErrorCodeSchema = z.enum([
  "BRANCH_NOT_FOUND",
  "BRANCH_ARCHIVED",
  "BRANCH_MISMATCH",
  "BRANCH_NAME_TAKEN",
  "BRANCH_PREVIEW_STALE",
  "BRANCH_DECISION_STALE",
  "REPOSITORY_NOT_CONFIGURED",
  "REPOSITORY_AUTHORIZATION_INVALID",
  "REPOSITORY_CONNECTION_EXISTS"
]);
export type BranchErrorCode = z.infer<typeof branchErrorCodeSchema>;

// A subset of `git check-ref-format` (spec §4.6). Every ref a provider sends
// passes it; slugSchema can't be reused because it forbids "/".
const forbiddenBranchCharacters = /[ ~^:?*[\\]/;
const hasControlCharacter = (name: string) =>
  [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
export const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      !forbiddenBranchCharacters.test(name) && !hasControlCharacter(name),
    {
      message:
        "Branch names cannot contain spaces, control characters or ~^:?*[\\."
    }
  )
  .refine((name) => !name.startsWith("-") && !name.startsWith("/"), {
    message: "Branch names cannot start with - or /."
  })
  .refine((name) => !name.endsWith("/") && !name.endsWith(".lock"), {
    message: "Branch names cannot end with / or .lock."
  })
  .refine(
    (name) =>
      !name.includes("..") &&
      !name.includes("//") &&
      !name.includes("@{") &&
      name !== "@",
    { message: "Branch names cannot contain .., //, @{ or be @." }
  );
export type BranchName = z.infer<typeof branchNameSchema>;

export const branchNameSourceSchema = z.enum([
  "fallback",
  "cli",
  "provider",
  "user"
]);
export type BranchNameSource = z.infer<typeof branchNameSourceSchema>;
export const branchCreatedViaSchema = z.enum([
  "migration",
  "dashboard",
  "cli",
  "agent",
  "provider"
]);
export type BranchCreatedVia = z.infer<typeof branchCreatedViaSchema>;
export const branchArchivedReasonSchema = z.enum([
  "provider_deleted",
  "manual",
  "replaced_on_connect"
]);
export type BranchArchivedReason = z.infer<typeof branchArchivedReasonSchema>;
export const branchOnboardingStateSchema = z.enum(["pending", "completed"]);
export type BranchOnboardingState = z.infer<typeof branchOnboardingStateSchema>;
export const branchOnboardingChoiceSchema = z.enum([
  "blank",
  "import_all",
  "selected"
]);
export type BranchOnboardingChoice = z.infer<
  typeof branchOnboardingChoiceSchema
>;

export const branchProviderStateSchema = z.object({
  provider: z.enum(["github", "gitlab", "origin"]),
  // tracked: an active provider ref is linked; missing: the linked ref was
  // deleted (only possible for the default branch, which is never archived);
  // untracked: a repository is connected but this branch was never seen there.
  state: z.enum(["tracked", "missing", "untracked"]),
  head_sha: z.string().max(64).nullable()
});
export type BranchProviderState = z.infer<typeof branchProviderStateSchema>;

export const branchSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  name: branchNameSchema,
  is_default: z.boolean(),
  name_source: branchNameSourceSchema,
  created_via: branchCreatedViaSchema,
  created_by: z
    .object({ type: z.enum(["human", "agent"]), id: idSchema })
    .nullable(),
  onboarding_state: branchOnboardingStateSchema,
  onboarding_choice: branchOnboardingChoiceSchema.nullable(),
  archived_at: dateSchema.nullable(),
  archived_reason: branchArchivedReasonSchema.nullable(),
  provider: branchProviderStateSchema.nullable(),
  open_decision_count: z.number().int().nonnegative(),
  created_at: dateSchema,
  updated_at: dateSchema
});
export type Branch = z.infer<typeof branchSchema>;

export const branchesResponseSchema = z.object({
  branches: z.array(branchSchema)
});
export type BranchesResponse = z.infer<typeof branchesResponseSchema>;
export const branchResponseSchema = z.object({ branch: branchSchema });
export type BranchResponse = z.infer<typeof branchResponseSchema>;

export const branchListQuerySchema = z.object({
  include_archived: booleanQuerySchema.default(false),
  name: branchNameSchema.optional()
});
export type BranchListQuery = z.infer<typeof branchListQuerySchema>;

export const createBranchRequestSchema = z.object({ name: branchNameSchema });
export type CreateBranchRequest = z.infer<typeof createBranchRequestSchema>;

export const registerBranchRequestSchema = z.object({
  name: branchNameSchema,
  git_default_branch: branchNameSchema.optional(),
  head_sha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  force_new: z.boolean().optional()
});
export type RegisterBranchRequest = z.infer<typeof registerBranchRequestSchema>;
export const registerBranchResponseSchema = z.object({
  branch: branchSchema,
  created: z.boolean()
});
export type RegisterBranchResponse = z.infer<
  typeof registerBranchResponseSchema
>;

export const branchOnboardingRequestSchema = z.object({
  choice: z.literal("blank")
});
export type BranchOnboardingRequest = z.infer<
  typeof branchOnboardingRequestSchema
>;

export const projectBranchParamsSchema = z.object({
  projectId: idSchema,
  branchId: idSchema
});
export const agentBranchParamsSchema = z.object({ branchId: idSchema });

/** Optional `?branch_id=` on human collection routes; absent = default branch. */
export const branchSelectorQuerySchema = z.object({
  branch_id: idSchema.optional()
});
export type BranchSelectorQuery = z.infer<typeof branchSelectorQuerySchema>;

/** Events and inbox: `?all_branches=true` returns every branch (spec §6.3). */
export const allBranchesQuerySchema = z.object({
  all_branches: booleanQuerySchema.default(false)
});
export type AllBranchesQuery = z.infer<typeof allBranchesQuerySchema>;

export const agentBranchHeaderSchema = idSchema;
