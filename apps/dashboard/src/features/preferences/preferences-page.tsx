import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTheme } from "@/features/theme/theme-provider";
import type { Theme } from "@/features/theme/theme";
import { usePreferences } from "@/platform/preferences-provider";

export function PreferencesPage({ recentProjectId }: { recentProjectId?: string }) {
  const { theme, setTheme } = useTheme();
  const { preferences, update } = usePreferences();
  const [saving, setSaving] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const write = async (change: () => void | Promise<void>) => {
    setSaving(true);
    try { await change(); } finally { setSaving(false); }
  };
  return <main id="main-content" tabIndex={-1} className="mx-auto min-h-screen w-full max-w-3xl p-6 md:p-8" aria-labelledby="preferences-heading">
    <div className="flex items-start justify-between gap-4"><div><h1 ref={heading} id="preferences-heading" tabIndex={-1} className="text-2xl font-semibold tracking-tight">Preferences</h1><p className="mt-2 text-sm text-muted-foreground">Application appearance and navigation preferences.</p></div>{recentProjectId ? <Link to="/projects/$projectId/overview" params={{ projectId: recentProjectId }} className="text-sm font-medium underline focus-visible:ring-2 focus-visible:ring-ring">Back to project</Link> : null}</div>
    <section className="mt-8 border-y py-6" aria-labelledby="theme-heading"><h2 id="theme-heading" className="font-medium">Appearance</h2><fieldset className="mt-4 flex w-fit rounded-md border p-1"><legend className="sr-only">Theme</legend>{(["system", "light", "dark"] as Theme[]).map((value) => <label key={value} className={`cursor-pointer rounded px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${theme === value ? "bg-muted" : ""}`}><input className="sr-only" type="radio" name="theme" value={value} checked={theme === value} onChange={() => void write(() => setTheme(value))} />{value[0].toUpperCase() + value.slice(1)}</label>)}</fieldset></section>
    <section className="border-b py-6" aria-labelledby="sidebar-heading"><h2 id="sidebar-heading" className="font-medium">Navigation</h2><label className="mt-4 flex items-center justify-between gap-4 text-sm"><span>Contextual sidebar</span><input type="checkbox" role="switch" aria-label="Contextual sidebar" checked={!preferences.contextSidebarCollapsed} onChange={() => void write(() => update({ contextSidebarCollapsed: !preferences.contextSidebarCollapsed }))} /></label></section>
    <section className="border-b py-6" aria-labelledby="rail-heading"><h2 id="rail-heading" className="font-medium">Rail mode</h2><p className="mt-2 text-sm">Projects</p><p className="mt-1 text-sm text-muted-foreground">Rail customization is not exposed in this build.</p></section>
    {saving ? <p role="status" className="mt-4 text-sm text-muted-foreground">Saving preferences…</p> : null}
  </main>;
}
