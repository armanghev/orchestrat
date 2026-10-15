import { z } from "zod";
import {
  createRepositoryAuthorizationRequestSchema,
  repositoryCandidateSchema
} from "./repository.js";

// Organization Git integrations: a GitHub App installation or a GitLab
// account connected once to an organization, the repositories it can reach,
// and importing one of them as a project. Owners and admins only.

const idSchema = z.string().uuid();
const dateSchema = z.string().datetime();
const authorizationIdSchema = z.string().regex(/^ra_[A-Za-z0-9_-]{20,}$/);
const providerRepositoryIdSchema = z.string().min(1).max(128);

export const integrationProviderSchema = z.enum(["github", "gitlab"]);
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;

/** GitHub: chosen on GitHub's install screen. GitLab: chosen in Orchestrat. */
export const repositorySelectionSchema = z.enum(["all", "selected"]);
export type RepositorySelection = z.infer<typeof repositorySelectionSchema>;

export const integrationStatusSchema = z.enum([
  "active",
  "needs_reauthorization",
  "suspended"
]);
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

export const organizationIntegrationSchema = z.object({
  id: idSchema,
  organization_id: idSchema,
  provider: integrationProviderSchema,
  /** GitHub account login or GitLab username. */
  account_name: z.string(),
  /** GitHub: "User" or "Organization"; GitLab: "User". */
  account_type: z.string().nullable(),
  repository_selection: repositorySelectionSchema,
  /** GitLab "selected": the chosen project ids. Empty otherwise. */
  selected_repository_ids: z.array(providerRepositoryIdSchema),
  repository_count: z.number().int().nonnegative(),
  status: integrationStatusSchema,
  status_reason: z.string().nullable(),
  /** Where to change repository access on the provider (GitHub). */
  manage_url: z.string().url().nullable(),
  connected_by_user_id: idSchema.nullable(),
  last_synced_at: dateSchema.nullable(),
  created_at: dateSchema,
  updated_at: dateSchema
});
export type OrganizationIntegration = z.infer<
  typeof organizationIntegrationSchema
>;

export const organizationIntegrationsResponseSchema = z.object({
  integrations: z.array(organizationIntegrationSchema)
});
export type OrganizationIntegrationsResponse = z.infer<
  typeof organizationIntegrationsResponseSchema
>;
export const organizationIntegrationResponseSchema = z.object({
  integration: organizationIntegrationSchema
});
export type OrganizationIntegrationResponse = z.infer<
  typeof organizationIntegrationResponseSchema
>;

/** Starts the provider's authorization for an organization. */
export const createIntegrationAuthorizationRequestSchema =
  createRepositoryAuthorizationRequestSchema.extend({
    provider: integrationProviderSchema
  });
export type CreateIntegrationAuthorizationRequest = z.infer<
  typeof createIntegrationAuthorizationRequestSchema
>;

/** GitHub: the app installations the signed-in person can use. */
export const githubInstallationOptionSchema = z.object({
  installation_id: z.string().regex(/^[1-9][0-9]{0,19}$/),
  account_name: z.string(),
  account_type: z.string().nullable(),
  repository_selection: repositorySelectionSchema,
  /** Already connected to this organization. */
  connected: z.boolean()
});
export type GithubInstallationOption = z.infer<
  typeof githubInstallationOptionSchema
>;
export const integrationAuthorizationOptionsResponseSchema = z.object({
  provider: integrationProviderSchema,
  /** GitHub only. */
  installations: z.array(githubInstallationOptionSchema),
  /** GitHub: install the app on another account or change its repositories. */
  install_url: z.string().url().nullable(),
  /** GitLab only: projects the person maintains, for "selected". */
  repositories: z.array(repositoryCandidateSchema)
});
export type IntegrationAuthorizationOptionsResponse = z.infer<
  typeof integrationAuthorizationOptionsResponseSchema
>;

export const createOrganizationIntegrationRequestSchema = z.discriminatedUnion(
  "provider",
  [
    z.object({
      provider: z.literal("github"),
      authorization_id: authorizationIdSchema,
      installation_id: z.string().regex(/^[1-9][0-9]{0,19}$/)
    }),
    z.object({
      provider: z.literal("gitlab"),
      authorization_id: authorizationIdSchema,
      repository_selection: repositorySelectionSchema,
      selected_repository_ids: z
        .array(providerRepositoryIdSchema)
        .max(1000)
        .default([])
    })
  ]
);
export type CreateOrganizationIntegrationRequest = z.infer<
  typeof createOrganizationIntegrationRequestSchema
>;

/** GitLab only; GitHub's selection changes on GitHub. */
export const updateOrganizationIntegrationRequestSchema = z.object({
  repository_selection: repositorySelectionSchema,
  selected_repository_ids: z
    .array(providerRepositoryIdSchema)
    .max(1000)
    .default([])
});
export type UpdateOrganizationIntegrationRequest = z.infer<
  typeof updateOrganizationIntegrationRequestSchema
>;

/** A repository an integration can reach, cached by the server. */
export const organizationRepositorySchema = z.object({
  id: idSchema,
  integration_id: idSchema,
  provider: integrationProviderSchema,
  provider_repository_id: providerRepositoryIdSchema,
  full_name: z.string(),
  url: z.string().nullable(),
  default_branch: z.string().nullable(),
  /** Last push, when the provider reports it. */
  pushed_at: dateSchema.nullable(),
  first_seen_at: dateSchema,
  /** Appeared after the integration was connected. */
  is_new: z.boolean(),
  /** The project already connected to it, if any. */
  project_id: idSchema.nullable(),
  dismissed: z.boolean()
});
export type OrganizationRepository = z.infer<
  typeof organizationRepositorySchema
>;
export const organizationRepositoriesQuerySchema = z.object({
  /** importable = not connected to a project and not dismissed. */
  filter: z.enum(["importable", "all"]).default("importable")
});
export const organizationRepositoriesResponseSchema = z.object({
  repositories: z.array(organizationRepositorySchema)
});
export type OrganizationRepositoriesResponse = z.infer<
  typeof organizationRepositoriesResponseSchema
>;
export const organizationRepositoryResponseSchema = z.object({
  repository: organizationRepositorySchema
});

/** Creates a project already connected to one of the organization's repositories. */
export const importRepositoryProjectRequestSchema = z.object({
  repository_id: idSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(4000).nullable().optional(),
  task_key_prefix: z
    .string()
    .trim()
    .min(2)
    .max(8)
    .regex(/^[a-zA-Z0-9]+$/)
    .transform((value) => value.toUpperCase())
    .optional()
});
export type ImportRepositoryProjectRequest = z.infer<
  typeof importRepositoryProjectRequestSchema
>;

/** Connects an existing project to one of the organization's repositories. */
export const connectOrganizationRepositoryRequestSchema = z.object({
  repository_id: idSchema
});
export type ConnectOrganizationRepositoryRequest = z.infer<
  typeof connectOrganizationRepositoryRequestSchema
>;

export const integrationParamsSchema = z.object({
  organizationId: idSchema,
  integrationId: idSchema
});
export const integrationAuthorizationParamsSchema = z.object({
  organizationId: idSchema,
  authorizationId: authorizationIdSchema
});
export const organizationRepositoryParamsSchema = z.object({
  organizationId: idSchema,
  repositoryId: idSchema
});
