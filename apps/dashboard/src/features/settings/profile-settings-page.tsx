import { useEffect, useRef, useState } from "react";
import type { Profile } from "@orchestrat/protocol";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTheme } from "@/features/theme/theme-provider";
import type { Theme } from "@/features/theme/theme";
import type { ApiClient } from "@/lib/api/client";

type ProfileSettingsProfile = Profile & {
  provider?: string | null;
  user_id?: string | null;
};

type ProfileSettingsPageProps = {
  profile: ProfileSettingsProfile;
  api: ApiClient;
  onProfileUpdated?: (profile: Profile) => void;
  onSignOut: () => void | Promise<void>;
};

const usernamePattern = /^[a-zA-Z0-9_]{3,32}$/;

export function ProfileSettingsPage({
  profile,
  api,
  onProfileUpdated,
  onSignOut
}: ProfileSettingsPageProps) {
  const { theme, setTheme } = useTheme();
  const heading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState(profile.username ?? "");
  const [fullName, setFullName] = useState(profile.full_name);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatar_url);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appearanceSaving, setAppearanceSaving] = useState(false);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    if (!avatarFile) {
      setLocalPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(avatarFile);
    setLocalPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  const trimmedUsername = username.trim();
  const trimmedFullName = fullName.trim();
  const usernameError =
    trimmedUsername.length > 0 && !usernamePattern.test(trimmedUsername)
      ? "Use 3–32 letters, numbers, or underscores."
      : null;
  const fullNameError =
    trimmedFullName.length === 0 ? "Full name is required." : null;
  const dirty =
    trimmedUsername !== (profile.username ?? "") ||
    trimmedFullName !== profile.full_name ||
    avatarFile !== null ||
    removeAvatar;
  const valid =
    usernamePattern.test(trimmedUsername) && trimmedFullName.length > 0;
  const previewUrl = removeAvatar ? null : localPreviewUrl ?? avatarUrl;

  const saveProfile = async () => {
    if (!dirty || !valid || saving) return;
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      let nextAvatarUrl = removeAvatar ? null : avatarUrl;
      if (removeAvatar) await api.removeAvatar();
      if (avatarFile) {
        const uploaded = await api.uploadAvatar(avatarFile);
        nextAvatarUrl = uploaded.avatar_url;
      }
      const updated = await api.updateProfile({
        username: trimmedUsername,
        full_name: trimmedFullName,
        avatar_url: nextAvatarUrl
      });
      setUsername(updated.username ?? "");
      setFullName(updated.full_name);
      setAvatarUrl(updated.avatar_url);
      setAvatarFile(null);
      setRemoveAvatar(false);
      if (fileInput.current) fileInput.current.value = "";
      onProfileUpdated?.(updated);
      setStatus("Profile saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Profile could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const changeTheme = async (value: Theme) => {
    setAppearanceSaving(true);
    setStatus(null);
    setError(null);
    try {
      await setTheme(value);
    } catch {
      setError("Appearance preferences could not be saved.");
    } finally {
      setAppearanceSaving(false);
    }
  };

  return (
    <div
      className="mx-auto min-h-screen w-full max-w-3xl p-6 md:p-8"
      aria-labelledby="profile-settings-heading"
    >
      <h1
        ref={heading}
        id="profile-settings-heading"
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight"
      >
        Profile
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Manage how you appear in Orchestrat.
      </p>

      <section className="mt-8 border-y py-6" aria-labelledby="profile-heading">
        <h2 id="profile-heading" className="font-medium">
          Profile details
        </h2>
        <div className="mt-5 flex items-start gap-6">
          <div className="relative size-40 shrink-0">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt=""
                className="size-40 rounded-full object-cover ring-1 ring-border"
              />
            ) : (
              <div
                aria-hidden="true"
                className="flex size-40 items-center justify-center rounded-full bg-muted text-2xl font-medium"
              >
                {(trimmedFullName || trimmedUsername || profile.email)[0]?.toUpperCase()}
              </div>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className="absolute right-1 bottom-1 rounded-full bg-background shadow-sm"
                  aria-label="Edit profile picture"
                  disabled={saving}
                >
                  <Pencil aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                  {avatarFile || avatarUrl ? "Change picture" : "Upload picture"}
                </DropdownMenuItem>
                {previewUrl ? (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      setRemoveAvatar(true);
                      setAvatarFile(null);
                    }}
                  >
                    Remove picture
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            <input
              ref={fileInput}
              className="sr-only"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Choose a profile picture"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                if (!file) return;
                setAvatarFile(file);
                setRemoveAvatar(false);
                setStatus(null);
                setError(null);
              }}
            />
          </div>
          <div className="ml-auto flex w-3/4 min-w-0 flex-col gap-5">
            <div className="flex flex-col items-start justify-start gap-2">
              <Label htmlFor="profile-full-name">Full name</Label>
              <Input
                id="profile-full-name"
                value={fullName}
                aria-invalid={fullNameError !== null}
                onChange={(event) => setFullName(event.target.value)}
                disabled={saving}
              />
              {fullNameError ? (
                <p className="text-sm text-destructive">{fullNameError}</p>
              ) : null}
            </div>
            <div className="flex flex-col items-start justify-start gap-2">
              <Label htmlFor="profile-username">Username</Label>
              <div className="relative w-full">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 select-none text-muted-foreground"
                >
                  @
                </span>
                <Input
                  id="profile-username"
                  className="pl-7"
                  value={username}
                  aria-invalid={usernameError !== null}
                  onChange={(event) => setUsername(event.target.value)}
                  disabled={saving}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Letters, numbers, and underscores only.
              </p>
              {usernameError ? (
                <p className="text-sm text-destructive">{usernameError}</p>
              ) : null}
            </div>
          </div>
        </div>
        <div className="mt-6 flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            JPEG, PNG, or WebP up to 2 MB.
          </p>
          <Button
            type="button"
            onClick={() => void saveProfile()}
            disabled={!dirty || !valid || saving}
          >
            {saving ? "Saving profile…" : "Save profile"}
          </Button>
        </div>
      </section>

      <section className="border-b py-6" aria-labelledby="account-heading">
        <h2 id="account-heading" className="font-medium">
          Account
        </h2>
        <dl className="mt-4 text-sm">
          <div>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="mt-1 break-words">{profile.email}</dd>
          </div>
        </dl>
      </section>

      <section className="border-b py-6" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading" className="font-medium">
          Appearance
        </h2>
        <fieldset className="mt-4 flex w-fit rounded-md border p-1">
          <legend className="sr-only">Theme</legend>
          {(["system", "light", "dark"] as Theme[]).map((value) => (
            <label
              key={value}
              className={`cursor-pointer rounded px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${theme === value ? "bg-muted" : ""}`}
            >
              <input
                className="sr-only"
                type="radio"
                name="profile-theme"
                value={value}
                checked={theme === value}
                disabled={appearanceSaving}
                onChange={() => void changeTheme(value)}
              />
              {value[0].toUpperCase() + value.slice(1)}
            </label>
          ))}
        </fieldset>
      </section>

      {status ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {profile.user_id ? (
        <p className="mt-10 break-all font-mono text-xs text-foreground/50">
          User ID: {profile.user_id}
        </p>
      ) : null}
      <section className="mt-8 border-t pt-6" aria-labelledby="profile-session-heading">
        <h2 id="profile-session-heading" className="font-medium">
          Session
        </h2>
        <Button
          type="button"
          variant="destructive"
          className="mt-4"
          onClick={() => void onSignOut()}
        >
          Sign out
        </Button>
      </section>
    </div>
  );
}
