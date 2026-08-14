export type Unsubscribe = () => void;

export interface PreferenceStore {
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
}

export interface Platform {
  kind: "desktop" | "web";
  preferences: PreferenceStore;
  openExternal(url: URL): Promise<void>;
  onAuthCallback(handler: (url: URL) => void): Promise<Unsubscribe>;
}
