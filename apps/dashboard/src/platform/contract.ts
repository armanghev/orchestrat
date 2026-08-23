export type Unsubscribe = () => void;

export interface PreferenceStore {
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
}

export type LocalIntegrationStatus = {
  supported: boolean;
  cli_exists: boolean;
  project_mapping: boolean;
  integrations: Partial<
    Record<
      "codex" | "claude-code",
      {
        mapped: boolean;
        mcp: boolean;
        hooks: boolean;
        credential: boolean;
      }
    >
  >;
  error?: string;
};

export interface Platform {
  kind: "desktop" | "web";
  preferences: PreferenceStore;
  openExternal(url: URL): Promise<void>;
  onAuthCallback(handler: (url: URL) => void): Promise<Unsubscribe>;
  localIntegrationStatus?(projectId: string): Promise<LocalIntegrationStatus>;
}
