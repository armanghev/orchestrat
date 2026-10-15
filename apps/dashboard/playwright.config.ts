import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:8814",
    trace: "on-first-retry"
  },
  webServer: {
    command:
      "VITE_API_URL=https://api.orchestrat.test VITE_E2E_AUTH=1 pnpm exec vite --mode e2e --host 127.0.0.1 --port 8814 --strictPort",
    port: 8814,
    reuseExistingServer: !process.env.CI
  },
  projects: [
    {
      name: "macos-default",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1280, height: 800 }
      }
    },
    {
      name: "macos-compact",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 960, height: 640 }
      }
    },
    {
      name: "phone-auth",
      grep: /@auth/,
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } }
    },
    {
      name: "phone-project",
      grep: /@phone/,
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } }
    }
  ]
});
