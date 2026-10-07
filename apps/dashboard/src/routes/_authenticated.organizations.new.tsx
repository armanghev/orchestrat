import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import {
  createOrganizationRequestSchema,
  slugifyName,
  type CreateOrganizationRequest
} from "@orchestrat/protocol";
import { WindowDragRegion } from "@/components/app-shell/top-toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  hierarchyKeys,
  organizationsQueryOptions
} from "@/features/hierarchy/query-options";
import { DashboardApiError } from "@/lib/api/client";
import { usePlatform } from "@/platform/provider";
import { cn } from "@/lib/cn";

function NewOrganization() {
  const router = useRouter();
  const { fromOrganization } = Route.useSearch();
  const desktop = usePlatform().kind === "desktop";
  const { api, queryClient } = router.options.context;
  const organizations = useQuery(organizationsQueryOptions(api));
  const previous =
    organizations.data?.organizations.find(
      (organization) => organization.id === fromOrganization
    ) ?? organizations.data?.organizations[0];
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [errors, setErrors] = useState<{
    name?: string;
    slug?: string;
    form?: string;
  }>({});
  const heading = useRef<HTMLHeadingElement>(null);
  const slugInput = useRef<HTMLInputElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const create = useMutation({
    mutationFn: (input: CreateOrganizationRequest) =>
      api.createOrganization(input)
  });

  useEffect(() => {
    if (errors.slug && !create.isPending) slugInput.current?.focus();
  }, [errors.slug, create.isPending]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) return;
    setErrors({});
    const parsed = createOrganizationRequestSchema.safeParse({ name, slug });
    if (!parsed.success) {
      setErrors({
        name: parsed.error.issues.some((issue) => issue.path[0] === "name")
          ? "Enter an organization name (1–120 characters)."
          : undefined,
        slug: parsed.error.issues.some((issue) => issue.path[0] === "slug")
          ? "Use 1–63 lowercase letters or numbers, separated by single hyphens."
          : undefined
      });
      return;
    }
    try {
      const created = await create.mutateAsync(parsed.data);
      await queryClient.invalidateQueries({
        queryKey: hierarchyKeys.all,
        refetchType: "none"
      });
      await router.navigate({
        to: "/organizations/$organizationId/projects/new",
        params: { organizationId: created.id }
      });
    } catch (cause) {
      if (
        cause instanceof DashboardApiError &&
        cause.kind === "ORGANIZATION_SLUG_TAKEN"
      ) {
        setErrors({ slug: "This slug is already taken. Choose another." });
      } else {
        setErrors({
          form:
            cause instanceof DashboardApiError
              ? cause.message
              : "Unable to create the organization. Try again."
        });
      }
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header
        className={cn(
          "relative flex h-14 shrink-0 items-center border-b px-4 select-none",
          desktop && "md:pl-22"
        )}
      >
        <WindowDragRegion />
        {previous ? (
          <Button
            asChild
            variant="ghost"
            className="relative z-10 min-w-0 gap-2 px-2"
          >
            <Link
              to="/organizations/$organizationId"
              params={{ organizationId: previous.id }}
            >
              <ArrowLeft aria-hidden="true" />
              <span className="truncate">Back to {previous.name}</span>
            </Link>
          </Button>
        ) : (
          <span className="relative z-10 text-sm font-semibold tracking-tight">
            Orchestrat
          </span>
        )}
      </header>
      <main id="main-content" className="flex flex-1 justify-center px-6 py-16">
        <section className="w-full max-w-md">
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight outline-none"
          >
            {previous ? "Create an organization" : "Create your organization"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Organizations hold your projects and the people who work on them.
          </p>
          {organizations.isPending ? (
            <div
              role="status"
              aria-label="Loading organizations"
              className="mt-6 space-y-4"
            >
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-40" />
            </div>
          ) : organizations.isError ? (
            <div className="mt-6 space-y-4">
              <p role="alert" className="text-sm text-destructive">
                Unable to load your organizations.
              </p>
              <Button
                variant="outline"
                onClick={() => void organizations.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <form
              className="mt-6 space-y-5"
              onSubmit={submit}
              noValidate
              aria-busy={create.isPending}
            >
              <div className="space-y-2">
                <Label htmlFor="organization-name">Organization name</Label>
                <Input
                  id="organization-name"
                  value={name}
                  maxLength={120}
                  required
                  autoComplete="organization"
                  disabled={create.isPending}
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={
                    errors.name ? "organization-name-error" : undefined
                  }
                  onChange={(event) => {
                    const value = event.target.value;
                    setName(value);
                    if (!slugEdited)
                      setSlug(value.trim() ? slugifyName(value) : "");
                    setErrors((current) => ({
                      ...current,
                      name: undefined,
                      ...(!slugEdited ? { slug: undefined } : {})
                    }));
                  }}
                />
                {errors.name && (
                  <p
                    id="organization-name-error"
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {errors.name}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="organization-slug">Organization slug</Label>
                <InputGroup>
                  <InputGroupAddon
                    className="font-mono text-xs"
                    aria-hidden="true"
                  >
                    org/
                  </InputGroupAddon>
                  <InputGroupInput
                    ref={slugInput}
                    id="organization-slug"
                    className="font-mono text-sm"
                    value={slug}
                    maxLength={63}
                    required
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={create.isPending}
                    aria-invalid={Boolean(errors.slug)}
                    aria-describedby={
                      errors.slug
                        ? "organization-slug-hint organization-slug-error"
                        : "organization-slug-hint"
                    }
                    onChange={(event) => {
                      setSlugEdited(true);
                      setSlug(event.target.value);
                      setErrors((current) => ({ ...current, slug: undefined }));
                    }}
                  />
                </InputGroup>
                <p
                  id="organization-slug-hint"
                  className="text-xs text-muted-foreground"
                >
                  A unique name for your organization. You can edit the
                  suggestion.
                </p>
                {errors.slug && (
                  <p
                    id="organization-slug-error"
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {errors.slug}
                  </p>
                )}
              </div>
              {errors.form && (
                <p role="alert" className="text-sm text-destructive">
                  {errors.form}
                </p>
              )}
              <Button type="submit" disabled={create.isPending}>
                {create.isPending
                  ? "Creating organization..."
                  : "Create organization"}
              </Button>
            </form>
          )}
        </section>
      </main>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/organizations/new")({
  validateSearch: z.object({
    fromOrganization: z.string().uuid().optional().catch(undefined)
  }),
  component: NewOrganization
});
