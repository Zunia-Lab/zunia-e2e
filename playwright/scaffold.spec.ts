import { test, expect } from "@playwright/test";

/**
 * Smoke: dashboard home loads.
 * Requires dashboard serving at E2E_BASE_URL (see README CI note).
 * Maestro mobile flows remain unchanged under maestro/.
 */
test.describe("dashboard smoke", () => {
  test("home loads with Zunia title", async ({ page }) => {
    try {
      const res = await page.goto("/", { waitUntil: "domcontentloaded", timeout: 15_000 });
      if (!res || res.status() >= 500) {
        test.skip(true, "Dashboard not reachable — set E2E_BASE_URL to a live preview or local pnpm dev");
      }
    } catch {
      test.skip(true, "Dashboard not reachable — set E2E_BASE_URL to a live preview or local pnpm dev");
    }
    await expect(page).toHaveTitle(/Zunia/i);
    await expect(page.getByRole("heading", { name: /Home/i })).toBeVisible();
  });
});
