import { test, expect } from "@playwright/test";

/**
 * Dashboard connect + receive surface smoke.
 * Full extension inject requires a Chromium profile with the unpacked extension.
 */
test.describe("dashboard connect surfaces", () => {
  test("portfolio loads connect CTA", async ({ page }) => {
    await page.goto("/portfolio");
    await expect(page.getByRole("button", { name: /connect/i }).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test("receive route is reachable", async ({ page }) => {
    await page.goto("/receive");
    await expect(page.locator("body")).toContainText(/receive|connect|address/i);
  });
});
