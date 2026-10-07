/**
 * With a wallet: a read-only Keplr stand-in (support/mock-wallet.ts) holding
 * a real retail address, restored on load the way a returning visitor's
 * wallet is. Nothing here signs; each test checks it never tried.
 *
 * Desktop width for the shell's controls (the chain rail, the privacy toggle
 * and the search field live in the desktop frame), then every wallet page at
 * phone width with its data on screen: one h1, no console error, nothing
 * wider than the screen.
 */

import {
  DESKTOP,
  PHONE,
  accountChip,
  expect,
  expectConnectPanel,
  expectNoHorizontalScroll,
  expectOneH1,
  settle,
  test,
  waitForAccount,
} from "./support/dashboard";
import { RETAIL_WALLET, installMockWallet, signAttempts } from "./support/mock-wallet";
import { WALLET_ROUTES } from "./support/routes";

/** A fiat figure as the kit formats it: "$46.56", "€1,234.50", "£0.0287". */
const MONEY = /^[$€£][\d,]+(\.\d+)?$/;

test.use(DESKTOP);

test.describe("with a read-only wallet", () => {
  test.beforeEach(async ({ context }) => {
    await installMockWallet(context, { addresses: RETAIL_WALLET });
  });

  test.afterEach(async ({ page }) => {
    expect(await signAttempts(page), "signing attempts").toBe(0);
  });

  test("Overview shows a net worth figure", async ({ page }) => {
    await page.goto("/overview");
    await waitForAccount(page);
    const netWorth = page.getByRole("region", { name: "Net worth", exact: true });
    await expect(netWorth).toBeVisible();
    // Live balances × live prices: the figure's shape, never its value.
    await expect(netWorth.getByText(MONEY).first()).toBeVisible({ timeout: 45_000 });
    await expect(netWorth.getByRole("radiogroup", { name: "History range" })).toBeVisible();
  });

  test("scope: the rail, the scope popover and the 0 shortcut switch every figure", async ({ page }) => {
    await page.goto("/overview");
    await waitForAccount(page);
    const rail = page.getByRole("complementary", { name: "Chain scope" });
    const allChains = rail.getByRole("button", { name: "All chains" });
    const scopeButton = page.getByRole("banner").getByRole("button", { name: /^Scope: / });
    const netWorth = page.getByRole("region", { name: "Net worth", exact: true });
    await expect(allChains).toHaveAttribute("aria-pressed", "true");
    await expect(scopeButton).toHaveAccessibleName(/^Scope: All chains/);

    // One chain from the rail: the rail, the top bar and the page follow.
    const osmosis = rail.getByRole("button", { name: /^Osmosis/ });
    await osmosis.click();
    await expect(osmosis).toHaveAttribute("aria-pressed", "true");
    await expect(allChains).toHaveAttribute("aria-pressed", "false");
    await expect(scopeButton).toHaveAccessibleName(/^Scope: Osmosis · osmosis-1/);
    await expect(netWorth.getByRole("button", { name: "Show all chains" })).toBeVisible();
    await expect(netWorth).toContainText("Osmosis");

    // Another one from the scope popover.
    await scopeButton.click();
    const popover = page.getByRole("dialog", { name: "Scope" });
    await expect(popover).toBeVisible();
    await popover.getByRole("button", { name: /^Cosmos Hub/ }).click();
    await expect(popover).toBeHidden();
    await expect(scopeButton).toHaveAccessibleName(/^Scope: Cosmos Hub · cosmoshub-4/);
    await expect(rail.getByRole("button", { name: /^Cosmos Hub/ })).toHaveAttribute("aria-pressed", "true");

    // "0" goes back to every chain.
    await page.locator("body").press("0");
    await expect(scopeButton).toHaveAccessibleName(/^Scope: All chains/);
    await expect(allChains).toHaveAttribute("aria-pressed", "true");
    await expect(netWorth.getByRole("button", { name: "Show all chains" })).toHaveCount(0);
  });

  test("privacy mode masks amounts, and is remembered", async ({ page }) => {
    await page.goto("/overview");
    await waitForAccount(page);
    const netWorth = page.getByRole("region", { name: "Net worth", exact: true });
    await expect(netWorth.getByText(MONEY).first()).toBeVisible({ timeout: 45_000 });

    await page.getByRole("button", { name: "Hide amounts" }).click();
    const show = page.getByRole("button", { name: "Show amounts" });
    await expect(show).toHaveAttribute("aria-pressed", "true");
    await expect(netWorth).toContainText("••••");
    await expect(netWorth).not.toContainText(/[$€£]\s?\d/);

    await page.reload();
    await waitForAccount(page);
    await expect(show).toBeVisible();
    await expect(netWorth).toContainText("••••");
    await expect(netWorth).not.toContainText(/[$€£]\s?\d/);

    await show.click();
    await expect(page.getByRole("button", { name: "Hide amounts" })).toHaveAttribute("aria-pressed", "false");
    await expect(netWorth.getByText(MONEY).first()).toBeVisible();
  });

  test("Meta+K opens the command palette, which navigates", async ({ page }) => {
    await page.goto("/overview");
    await waitForAccount(page);
    await page.keyboard.press("Meta+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    const search = palette.getByRole("combobox", { name: "Search pages, chains, assets and actions" });
    await expect(search).toBeFocused();

    // Esc closes it (the field is empty), and the shortcut brings it back.
    await search.press("Escape");
    await expect(palette).toBeHidden();
    await page.keyboard.press("Meta+K");
    await expect(palette).toBeVisible();

    await search.fill("markets");
    const option = palette.getByRole("option", { name: /^Markets/ }).first();
    await expect(option).toBeVisible();
    await option.click();
    await expect(page).toHaveURL(/\/markets$/);
    await expect(palette).toBeHidden();
  });

  test("the bell opens the notifications popover", async ({ page }) => {
    await page.goto("/overview");
    await waitForAccount(page);
    const bell = page.getByRole("banner").getByRole("button", { name: /^Notifications/ });
    await bell.click();
    const popover = page.getByRole("dialog", { name: "Notifications" });
    await expect(popover).toBeVisible();
    await expect(popover.getByRole("heading", { name: "Notifications" })).toBeVisible();
    await expect(popover.getByRole("tab", { name: /^All/ })).toBeVisible();
    await expect(popover.getByRole("tab", { name: /^Unread/ })).toBeVisible();
    // Preferences live in Settings; the centre only lists.
    await expect(popover.getByRole("link", { name: "Notification settings" })).toHaveAttribute("href", "/settings#notifications");
    await expect(popover.getByRole("link", { name: /Open notification center/ })).toHaveAttribute("href", "/notifications");
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  });

  test("the account menu switches the theme and the currency", async ({ page }) => {
    await page.goto("/overview");
    await waitForAccount(page);
    const netWorth = page.getByRole("region", { name: "Net worth", exact: true });
    await expect(netWorth.getByText(/^\$[\d,]+(\.\d+)?$/).first()).toBeVisible({ timeout: 45_000 });
    const html = page.locator("html");
    // Dark is the default, whatever the OS prefers.
    await expect(html).toHaveAttribute("data-theme", "dark");

    await accountChip(page).click();
    const menu = page.getByRole("dialog", { name: "Account" });
    await expect(menu).toBeVisible();
    await menu.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await menu.getByRole("radiogroup", { name: "Currency" }).getByRole("radio", { name: "EUR" }).click();
    await page.keyboard.press("Escape");

    // Re-priced in euros (or, without an FX rate, still dollars and saying so).
    const inEuros = netWorth.getByText(/^€[\d,]+(\.\d+)?$/).or(page.getByText(/^Values are shown in USD/)).first();
    await expect(inEuros).toBeVisible({ timeout: 45_000 });
    // Both are remembered.
    await page.reload();
    await waitForAccount(page);
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(inEuros).toBeVisible({ timeout: 45_000 });
  });

  test("Disconnect brings the connect panel back", async ({ page }) => {
    await page.goto("/staking");
    await waitForAccount(page);
    await accountChip(page).click();
    await page.getByRole("button", { name: /^Disconnect/ }).click();
    await expect(accountChip(page)).toHaveCount(0);
    await expectConnectPanel(page, { keplr: "detected" });
    await expect(page.getByRole("banner").getByRole("button", { name: "Connect wallet" })).toBeVisible();
  });
});

test.describe("wallet pages with a wallet, on a phone", () => {
  test.use(PHONE);

  test.beforeEach(async ({ context }) => {
    await installMockWallet(context, { addresses: RETAIL_WALLET });
  });

  for (const route of WALLET_ROUTES) {
    test(`${route.path} renders the wallet's data`, async ({ page, consoleWatch }) => {
      const response = await page.goto(route.path);
      expect(response?.status()).toBe(200);
      await waitForAccount(page);
      // The page itself, not the connect panel.
      await expect(page.getByRole("main").getByText("Non-custodial: every transaction is approved in your wallet or on your phone.")).toHaveCount(0);
      await settle(page, 15_000);
      await expectOneH1(page, route.heading);
      await expectNoHorizontalScroll(page);
      consoleWatch.expectClean();
      expect(await signAttempts(page)).toBe(0);
    });
  }
});

test.describe("connecting from the page", () => {
  test("the Connect wallet modal closes on Escape and gives focus back", async ({ page }) => {
    await page.goto("/markets");
    const connect = page.getByRole("banner").getByRole("button", { name: "Connect wallet" });
    await connect.click();
    const modal = page.getByRole("dialog", { name: "Connect a wallet" });
    await expect(modal).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    await expect(connect).toBeFocused();
  });

  test("Keplr connects from a wallet page's connect panel", async ({ context, page }) => {
    // No reconnect hint: the visitor connects by hand.
    await installMockWallet(context, { addresses: RETAIL_WALLET, restore: false });
    await page.goto("/staking");
    // Detected: Keplr's row connects instead of linking to the install page.
    await expectConnectPanel(page, { keplr: "detected" });
    await page.getByRole("main").getByRole("button", { name: /^Keplr/ }).click();
    await waitForAccount(page);
    await expect(page.getByRole("region", { name: "Positions" })).toBeVisible();
    // The next visit restores without a click.
    await page.reload();
    await waitForAccount(page);
    expect(await signAttempts(page)).toBe(0);
  });
});
