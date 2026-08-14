import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry"
  },
  webServer: {
    command:
      "VITE_API_URL=http://api.orchestrat.test VITE_CLERK_PUBLISHABLE_KEY=pk_test_e2e VITE_E2E_AUTH=1 pnpm exec vite --mode e2e --host 127.0.0.1 --port 4173 --strictPort",
    port: 4173,
    reuseExistingServer: !process.env.CI
  },
  projects: [
    {
      name: "macos-default",
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } }
    },
    {
      name: "macos-compact",
      use: { ...devices["Desktop Safari"], viewport: { width: 960, height: 640 } }
    }
  ]
});
