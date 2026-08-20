import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  envDir: ".",
  plugins: [
    tanstackRouter({
      autoCodeSplitting: true,
      target: "react",
      routeFileIgnorePattern: "\\.test\\.(ts|tsx)$"
    }),
    react(),
    tailwindcss()
  ],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  server: {
    host: host || false,
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] }
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./vitest.setup.ts",
    exclude: [...configDefaults.exclude, "e2e/**"]
  }
});
