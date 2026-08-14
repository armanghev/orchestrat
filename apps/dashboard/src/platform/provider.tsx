import { createContext, useContext, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { createBrowserPlatform } from "./browser";
import type { Platform } from "./contract";
import { createTauriPlatform } from "./tauri";

const PlatformContext = createContext<Platform | null>(null);
const defaultPlatform = isTauri()
  ? createTauriPlatform()
  : createBrowserPlatform();

interface PlatformProviderProps {
  children: ReactNode;
  value?: Platform;
}

export function PlatformProvider({
  children,
  value
}: PlatformProviderProps) {
  return (
    <PlatformContext.Provider value={value ?? defaultPlatform}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform(): Platform {
  const platform = useContext(PlatformContext);
  if (!platform) throw new Error("usePlatform must be used within PlatformProvider.");
  return platform;
}
