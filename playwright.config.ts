import { defineConfig, devices } from "@playwright/test";

/**
 * Extension E2E needs a packed MV3 build + persistent context.
 * Config scaffold only — tests are skipped until wallet MVP exists.
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
