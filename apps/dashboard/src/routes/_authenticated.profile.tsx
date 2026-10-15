import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ProfileSettingsPage } from "@/features/settings/profile-settings-page";
import { ProfileSettingsShell } from "@/features/settings/profile-settings-shell";

function ProfileRoute() {
  const router = useRouter();
  const { api, auth, queryClient } = router.options.context;
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.getProfile()
  });

  if (profileQuery.isPending)
    return (
      <div
        className="h-dvh animate-pulse bg-background"
        aria-label="Loading profile"
      />
    );

  if (profileQuery.isError)
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Profile unavailable
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We couldn’t load your profile.
        </p>
        <button
          type="button"
          className="mt-6 w-fit text-sm font-medium underline"
          onClick={() => void profileQuery.refetch()}
        >
          Retry
        </button>
      </main>
    );

  return (
    <ProfileSettingsShell>
      <ProfileSettingsPage
        profile={profileQuery.data}
        api={api}
        onProfileUpdated={(profile) =>
          queryClient.setQueryData(["profile"], profile)
        }
        onSignOut={() => auth.signOut()}
        onSignOutEverywhere={() => auth.signOutEverywhere()}
        onChangePassword={(current, next) => auth.changePassword(current, next)}
      />
    </ProfileSettingsShell>
  );
}

export const Route = createFileRoute("/_authenticated/profile")({
  component: ProfileRoute
});
