import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { PreferenceStore } from "./contract";
import { parsePreferences, preferencesSchema, type Preferences } from "./preferences";
import { usePlatform } from "./provider";

export type PreferencesUpdate = Omit<Partial<Preferences>, "railMode"> & {
  railMode?: Preferences["railMode"];
};
export type PreferencesContextValue = { preferences: Preferences; ready: boolean; update: (update: PreferencesUpdate) => Promise<void> };
type PendingWrite = { revision: number; update: PreferencesUpdate; snapshot: Preferences };
type Deferred = { promise: Promise<void>; resolve: () => void };
type LoadResult = { preferences: Preferences; error?: string };
const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function clonePreferences(preferences: Preferences): Preferences { return { ...preferences, pinnedProjectIds: [...preferences.pinnedProjectIds], recentProjectIds: [...preferences.recentProjectIds] }; }
function createDeferred(): Deferred { let resolve: () => void = () => undefined; const promise = new Promise<void>((complete) => { resolve = () => complete(); }); return { promise, resolve }; }

export function PreferencesProvider({ children, store, initialPreferences }: { children: ReactNode; store?: PreferenceStore; initialPreferences?: Preferences }) {
  const platform = usePlatform();
  const sourceRef = useRef<{ preferenceStore: PreferenceStore; initialPreferences?: Preferences } | null>(null);
  if (!sourceRef.current) sourceRef.current = { preferenceStore: store ?? platform.preferences, initialPreferences };
  const { preferenceStore, initialPreferences: initialOverride } = sourceRef.current;
  const initial = initialOverride ? parsePreferences(initialOverride) : parsePreferences(undefined);
  const [preferences, setPreferences] = useState(initial);
  const [ready, setReady] = useState(initialOverride !== undefined);
  const [error, setError] = useState<string | null>(null);
  const preferencesRef = useRef(initial);
  const committedRef = useRef(clonePreferences(initial));
  const revisionRef = useRef(0);
  const readyRef = useRef(initialOverride !== undefined);
  const preReadyWrites = useRef<PendingWrite[]>([]);
  const readyGate = useRef<Deferred | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const loadResult = useRef<Promise<LoadResult> | null>(null);
  if (!readyGate.current) readyGate.current = createDeferred();

  useEffect(() => {
    if (initialOverride !== undefined) { readyGate.current?.resolve(); return; }
    let active = true;
    const finishLoad = (base: Preferences, message?: string) => {
      if (!active) return;
      committedRef.current = clonePreferences(base);
      let rebased = base;
      for (const write of preReadyWrites.current) {
        const candidate = preferencesSchema.safeParse({ ...rebased, ...write.update });
        if (candidate.success) { rebased = candidate.data; write.snapshot = clonePreferences(rebased); }
      }
      preferencesRef.current = clonePreferences(rebased);
      setPreferences(rebased);
      readyRef.current = true;
      if (message) setError(message);
      setReady(true);
      readyGate.current?.resolve();
    };
    loadResult.current ??= preferenceStore.load().then(
      (stored) => ({ preferences: parsePreferences(stored) }),
      () => ({ preferences: parsePreferences(undefined), error: "Preferences could not be loaded." })
    );
    void loadResult.current.then(({ preferences: loaded, error }) => finishLoad(loaded, error));
    return () => { active = false; };
  }, [initialOverride, preferenceStore]);

  const update = useCallback(async (partial: PreferencesUpdate) => {
    const candidate = preferencesSchema.safeParse({ ...preferencesRef.current, ...partial });
    if (!candidate.success) { setError("Preferences could not be saved."); return; }
    const revision = ++revisionRef.current;
    const write: PendingWrite = { revision, update: partial, snapshot: clonePreferences(candidate.data) };
    if (!readyRef.current) preReadyWrites.current.push(write);
    preferencesRef.current = clonePreferences(candidate.data);
    setPreferences(candidate.data);
    setError(null);
    const task = writes.current.then(async () => {
      await readyGate.current?.promise;
      await preferenceStore.save(write.snapshot);
      committedRef.current = clonePreferences(write.snapshot);
    });
    writes.current = task.catch(() => undefined);
    try { await task; } catch {
      if (revision === revisionRef.current) {
        const committed = clonePreferences(committedRef.current);
        preferencesRef.current = committed;
        setPreferences(committed);
        setError("Preferences could not be saved. Your change was reverted.");
      }
    }
  }, [preferenceStore]);

  return <PreferencesContext.Provider value={{ preferences, ready, update }}>
    {children}
    {error ? <p role="alert" className="sr-only">{error}</p> : null}
  </PreferencesContext.Provider>;
}
export function usePreferences(): PreferencesContextValue { const value = useContext(PreferencesContext); if (!value) throw new Error("usePreferences must be used within PreferencesProvider."); return value; }
