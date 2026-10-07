import { defineConfig, devices } from "@playwright/test";

/**
 * The dashboard suite (playwright/): smoke, a read-only mock wallet, headers,
 * API contracts and regressions, against the dashboard at E2E_BASE_URL
 * (`pnpm dev` in zunia-dashboard, a preview, production). Every test skips
 * itself when nothing answers there; E2E_REQUIRE_DASHBOARD=1 turns that into
 * a failure. The extension/SDK/relay stack has its own config
 * (playwright.stack.config.ts); Maestro phone flows live under maestro/.
 */
export default defineConfig({
  testDir: "./playwright",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // The pages read live chain data through the dashboard's API: a few
  // browsers at a time keep a dev server and the public nodes responsive.
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : process.env.CI ? 2 : 4,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
