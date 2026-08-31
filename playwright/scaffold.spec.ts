import { test, expect } from "@playwright/test";

test.describe("scaffold", () => {
  test.skip(true, "Wallet MVP not implemented — enable when dashboard/extension ship");

  test("placeholder", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Zunia/i);
  });
});
