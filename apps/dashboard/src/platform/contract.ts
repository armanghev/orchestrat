import { z } from "zod";

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

export const nativeNotificationDestinationSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("task"),
      projectId: z.string().uuid(),
      taskId: z.string().uuid()
    }),
    z.object({
      kind: z.literal("activity"),
      projectId: z.string().uuid()
    }),
    z.object({
      kind: z.literal("chat"),
      projectId: z.string().uuid(),
      chatId: z.string().uuid()
    })
  ]
);
export type NativeNotificationDestination = z.infer<
  typeof nativeNotificationDestinationSchema
>;

export type NativeNotification = {
  title: string;
  body: string;
  destination: NativeNotificationDestination;
};

export interface Platform {
  kind: "desktop" | "web";
  preferences: PreferenceStore;
  openExternal(url: URL): Promise<void>;
  onAuthCallback(handler: (url: URL) => void): Promise<Unsubscribe>;
  onNotificationAction?(
    handler: (destination: NativeNotificationDestination) => void
  ): Promise<Unsubscribe>;
  isBackgrounded?(): Promise<boolean>;
  notify?(notification: NativeNotification): Promise<void>;
  localIntegrationStatus?(projectId: string): Promise<LocalIntegrationStatus>;
}
