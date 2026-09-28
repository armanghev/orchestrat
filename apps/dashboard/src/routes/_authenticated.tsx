import {
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
  useRouter
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { projectCatalogQueryOptions } from "@/features/hierarchy/query-options";
import { ProjectRealtimeProvider } from "@/realtime/project-realtime";
import { usePlatform } from "@/platform/provider";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ context }) => {
    await context.auth.initialize();
    if (context.auth.getSnapshot().status !== "signedIn") {
      throw redirect({ to: "/" });
    }
  },
  component: AuthenticatedLayout
});

function AuthenticatedLayout() {
  const router = useRouter();
  const navigate = useNavigate();
  const location = useLocation();
  const platform = usePlatform();
  const { api, queryClient } = router.options.context;
  const catalog = useQuery({
    ...projectCatalogQueryOptions(api),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true
  });
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.getProfile()
  });
  const projectIds =
    catalog.data?.projects.map(({ project }) => project.id) ?? [];
  const activeProjectId = decodeURIComponent(
    location.pathname.match(/^\/projects\/([^/]+)/u)?.[1] ?? ""
  );
  const navigateToChat = (projectId: string, chatId: string) =>
    navigate({
      to: "/projects/$projectId/messages",
      params: { projectId },
      search: { chat: chatId }
    });

  return (
    <ProjectRealtimeProvider
      api={api}
      queryClient={queryClient}
      projectIds={projectIds}
      activeProjectId={activeProjectId}
      currentUserId={profile.data?.user_id}
      platform={platform}
      navigateToChat={navigateToChat}
    >
      <Outlet />
    </ProjectRealtimeProvider>
  );
}
