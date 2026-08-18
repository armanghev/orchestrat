import { useEffect, useRef, useState } from "react";
import type { Profile } from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTheme } from "@/features/theme/theme-provider";
import type { Theme } from "@/features/theme/theme";
import type { ApiClient } from "@/lib/api/client";
import { usePreferences } from "@/platform/preferences-provider";

type ProfileSettingsProfile = Profile & {
  provider?: string | null;
  user_id?: string | null;
};

type ProfileSettingsPageProps = {
  profile: ProfileSettingsProfile;
  api: ApiClient;
  onProfileUpdated?: (profile: Profile) => void;
};

const usernamePattern = /^[a-zA-Z0-9_]{3,32}$/;

export function ProfileSettingsPage({
  profile,
  api,
  onProfileUpdated
}: ProfileSettingsPageProps) {
  const { theme, setTheme } = useTheme();
  const { preferences, update } = usePreferences();
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

  const changeSidebar = async () => {
    setAppearanceSaving(true);
    setStatus(null);
    setError(null);
    try {
      await update({
        contextSidebarCollapsed: !preferences.contextSidebarCollapsed
      });
    } catch {
      setError("Navigation preferences could not be saved.");
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
        <div className="mt-5 flex items-center gap-4">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt=""
              className="size-16 rounded-full object-cover ring-1 ring-border"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex size-16 items-center justify-center rounded-full bg-muted text-lg font-medium"
            >
              {(trimmedFullName || trimmedUsername || profile.email)[0]?.toUpperCase()}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInput.current?.click()}
              disabled={saving}
            >
              {avatarFile || avatarUrl ? "Change picture" : "Upload picture"}
            </Button>
            {avatarUrl || avatarFile ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setRemoveAvatar(true);
                  setAvatarFile(null);
                }}
                disabled={saving}
              >
                Remove
              </Button>
            ) : null}
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
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          JPEG, PNG, or WebP up to 2 MB.
        </p>

        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <div className="grid gap-2">
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
          <div className="grid gap-2">
            <Label htmlFor="profile-username">Username</Label>
            <Input
              id="profile-username"
              value={username}
              aria-invalid={usernameError !== null}
              onChange={(event) => setUsername(event.target.value)}
              disabled={saving}
            />
            <p className="text-sm text-muted-foreground">
              Letters, numbers, and underscores only.
            </p>
            {usernameError ? (
              <p className="text-sm text-destructive">{usernameError}</p>
            ) : null}
          </div>
        </div>
        <Button
          className="mt-6"
          type="button"
          onClick={() => void saveProfile()}
          disabled={!dirty || !valid || saving}
        >
          {saving ? "Saving profile…" : "Save profile"}
        </Button>
      </section>

      <section className="border-b py-6" aria-labelledby="account-heading">
        <h2 id="account-heading" className="font-medium">
          Account
        </h2>
        <dl className="mt-4 grid gap-4 text-sm md:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="mt-1 break-words">{profile.email}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Provider</dt>
            <dd className="mt-1">{profile.provider ?? "Supabase"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">User ID</dt>
            <dd className="mt-1 break-all font-mono text-xs">
              {profile.user_id ?? "Unavailable"}
            </dd>
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
        <label className="mt-5 flex items-center justify-between gap-4 text-sm">
          <span>Contextual sidebar</span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Contextual sidebar"
            checked={!preferences.contextSidebarCollapsed}
            disabled={appearanceSaving}
            onChange={() => void changeSidebar()}
          />
        </label>
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
    </div>
  );
}
