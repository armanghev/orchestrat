import { useEffect, useRef, useState } from "react";
import {
  Navigate,
  createFileRoute,
  useNavigate,
  useRouter
} from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DashboardApiError } from "@/lib/api/client";

function OnboardingRoute() {
  const router = useRouter();
  const navigate = useNavigate();
  const { api } = router.options.context;
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.getProfile()
  });
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);
  const updateProfile = useMutation({
    mutationFn: async () => {
      const uploaded = avatarFile ? await api.uploadAvatar(avatarFile) : null;
      return api.updateProfile({
        username,
        full_name: fullName,
        avatar_url:
          uploaded?.avatar_url ?? profileQuery.data?.avatar_url ?? null
      });
    },
    onSuccess: async () => {
      await profileQuery.refetch();
      await navigate({ to: "/setup", replace: true });
    },
    onError: (cause) => {
      setError(
        cause instanceof DashboardApiError
          ? cause.message
          : "We couldn’t save your profile. Try again."
      );
    }
  });

  useEffect(() => {
    if (!profileQuery.data || initialized.current) return;
    initialized.current = true;
    setUsername(
      profileQuery.data.username ?? profileQuery.data.suggested_username ?? ""
    );
    setFullName(profileQuery.data.full_name);
  }, [profileQuery.data]);

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(avatarFile);
    setAvatarPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  if (profileQuery.isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p role="status">Loading your profile…</p>
      </main>
    );
  }
  if (profileQuery.data?.username) return <Navigate to="/setup" replace />;

  return (
    <main className="min-h-screen bg-background px-6 py-10">
      <section className="mx-auto w-full max-w-lg">
        <p className="text-sm font-semibold tracking-tight">Orchestrat</p>
        <h1 className="mt-12 text-3xl font-semibold tracking-tight">
          Set up your profile
        </h1>
        <p className="mt-3 text-muted-foreground">
          Tell us how you’d like to appear in your workspace.
        </p>
        <form
          className="mt-8 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            updateProfile.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="onboarding-username">Username or handle</Label>
            <Input
              id="onboarding-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="armanghevondyan"
              autoComplete="username"
              required
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9_]+"
              disabled={updateProfile.isPending}
            />
            <p className="text-xs text-muted-foreground">
              Letters, numbers, and underscores only.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="onboarding-full-name">Full name</Label>
            <Input
              id="onboarding-full-name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              autoComplete="name"
              required
              maxLength={120}
              disabled={updateProfile.isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="onboarding-avatar">
              Profile picture (optional)
            </Label>
            {avatarPreviewUrl || profileQuery.data?.avatar_url ? (
              <img
                src={avatarPreviewUrl ?? profileQuery.data?.avatar_url ?? ""}
                alt=""
                className="size-16 rounded-full object-cover ring-1 ring-border"
              />
            ) : null}
            <Input
              id="onboarding-avatar"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                if (file && file.size > 2 * 1024 * 1024) {
                  setAvatarFile(null);
                  setError("Choose an image no larger than 2 MB.");
                  event.target.value = "";
                  return;
                }
                setError(null);
                setAvatarFile(file);
              }}
              disabled={updateProfile.isPending}
            />
            <p className="text-xs text-muted-foreground">
              JPEG, PNG, or WebP up to 2 MB.
            </p>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={updateProfile.isPending}>
            {updateProfile.isPending ? "Saving profile…" : "Continue"}
          </Button>
        </form>
      </section>
    </main>
  );
}

export const Route = createFileRoute("/_authenticated/onboarding")({
  component: OnboardingRoute
});
