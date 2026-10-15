import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { AppProviders } from "@/app/providers";
import { parsePublicConfig } from "@/app/config";
import "@/globals.css";

const element = document.getElementById("root");
if (!element) throw new Error("Dashboard root element is missing.");

const runtime = isTauri() ? "desktop" : "web";
const config = parsePublicConfig(
  import.meta.env,
  runtime,
  window.location.origin
);

createRoot(element).render(
  <StrictMode>
    <AppProviders config={config} />
  </StrictMode>
);
