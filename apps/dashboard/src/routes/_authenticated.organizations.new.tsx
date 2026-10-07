import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { createOrganizationRequestSchema } from "@orchestrat/protocol";
import { WindowDragRegion } from "@/components/app-shell/top-toolbar";
import { Button } from "@/components/ui/button";
import {
  CreationForm,
  type CreationInput
} from "@/features/hierarchy/creation-form";
import {
  hierarchyKeys,
  organizationsQueryOptions
} from "@/features/hierarchy/query-options";
import { usePlatform } from "@/platform/provider";
import { cn } from "@/lib/cn";

// ponytail: the plain organization form; ORC-53 adds the slug field.
function NewOrganization() {
  const router = useRouter();
  const desktop = usePlatform().kind === "desktop";
  const { api, queryClient } = router.options.context;
  const organizations = useQuery(organizationsQueryOptions(api));
  const hasOrganization = Boolean(organizations.data?.organizations.length);
  const create = useMutation({
    mutationFn: (input: CreationInput) =>
      api.createOrganization(
        createOrganizationRequestSchema.parse({ name: input.name })
      )
  });
  return (
    <div className="flex h-full min-h-dvh flex-col bg-background">
      <header
        className={cn(
          "relative flex h-14 shrink-0 items-center border-b px-4 select-none",
          desktop && "md:pl-22"
        )}
      >
        <WindowDragRegion />
        {hasOrganization ? (
          <Button
            type="button"
            variant="ghost"
            className="relative z-10 gap-2 px-2"
            onClick={() => router.history.back()}
          >
            <ArrowLeft aria-hidden="true" />
            Back
          </Button>
        ) : (
          <span className="relative z-10 text-sm font-semibold tracking-tight">
            Orchestrat
          </span>
        )}
      </header>
      <main className="flex flex-1 justify-center px-6 py-16">
        <CreationForm
          kind="organization"
          title={
            hasOrganization
              ? "Create an organization"
              : "Create your organization"
          }
          description="Organizations hold your projects and the people who work on them."
          pending={create.isPending}
          onSubmit={async (input) => {
            const created = await create.mutateAsync(input);
            await queryClient.invalidateQueries({
              queryKey: hierarchyKeys.all
            });
            await router.navigate({
              to: "/organizations/$organizationId/projects/new",
              params: { organizationId: created.id }
            });
          }}
        />
      </main>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/organizations/new")({
  component: NewOrganization
});
