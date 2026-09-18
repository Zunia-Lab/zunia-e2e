import { defineConfig, devices } from "@playwright/test";

/**
 * Config scaffold — dashboard smoke is active when E2E_BASE_URL is reachable.
 * Maestro mobile flows are separate under maestro/.
 */
export default defineConfig({
  testDir: "./playwright",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    trace: "on-first-retry",
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
