/**
 * Smoke: every page renders for a visitor without a wallet, at phone width.
 *
 * Public pages answer 200 with their own title, one h1, no console error and
 * nothing wider than a 390 px screen. Wallet pages render the connect panel
 * in place of their content (no global wallet gate). Unknown URLs are real
 * 404s, not soft ones.
 */

import {
  PHONE,
  expect,
  expectConnectPanel,
  expectNoHorizontalScroll,
  expectOneH1,
  settle,
  test,
} from "./support/dashboard";
import { firstMarketAsset, firstProposal, firstValidator, latestTransaction } from "./support/live";
import { ACTIVE_WALLET } from "./support/mock-wallet";
import { PUBLIC_ROUTES, WALLET_ROUTES } from "./support/routes";

test.describe("public pages", () => {
  test.use(PHONE);

  for (const route of PUBLIC_ROUTES) {
    test(`${route.path} renders for a visitor`, async ({ page, consoleWatch }) => {
      const response = await page.goto(route.path);
      expect(response?.status(), "HTTP status").toBe(200);
      await expect(page).toHaveTitle(route.title);
      await settle(page);
      await expectOneH1(page, route.heading);
      await expectNoHorizontalScroll(page);
      consoleWatch.expectClean();
    });
  }
});

test.describe("public detail pages (identifiers read from the API)", () => {
  test.use(PHONE);

  test("a validator page", async ({ page, request, consoleWatch }) => {
    const operator = await firstValidator(request, "cosmoshub-4");
    test.skip(!operator, "The validator set could not be read right now");
    const response = await page.goto(`/validators/${operator}?chain=cosmoshub-4`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/ · Cosmos Hub validator · Zunia$/);
    await settle(page);
    await expectOneH1(page);
    await expectNoHorizontalScroll(page);
    consoleWatch.expectClean();
  });

  test("a proposal page", async ({ page, request, consoleWatch }) => {
    const id = await firstProposal(request, "cosmoshub-4");
    test.skip(!id, "No proposal could be read right now");
    const response = await page.goto(`/governance/cosmoshub-4/${id}`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(new RegExp(`Cosmos Hub #${id} · Zunia$`));
    await settle(page);
    await expectOneH1(page);
    await expectNoHorizontalScroll(page);
    consoleWatch.expectClean();
  });

  test("an asset page (market part public)", async ({ page, request, consoleWatch }) => {
    const key = await firstMarketAsset(request);
    test.skip(!key, "Markets could not be read right now");
    const response = await page.goto(`/assets/${encodeURIComponent(key as string)}`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/(price, chart and market data|token details) · Zunia$/);
    await settle(page);
    await expectOneH1(page);
    await expectNoHorizontalScroll(page);
    consoleWatch.expectClean();
  });

  test("a transaction page", async ({ page, request, consoleWatch }) => {
    const tx = await latestTransaction(request, ACTIVE_WALLET);
    test.skip(!tx, "No transaction could be read right now");
    const { hash, chainId } = tx as { hash: string; chainId: string };
    const response = await page.goto(`/activity/${encodeURIComponent(hash)}?chainId=${encodeURIComponent(chainId)}`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/^Transaction [0-9A-F]{6}.*[0-9A-F]{4} · Zunia$/i);
    await settle(page);
    await expectOneH1(page, "Transaction");
    await expectNoHorizontalScroll(page);
    consoleWatch.expectClean();
  });
});

test.describe("wallet pages without a wallet", () => {
  test.use(PHONE);

  for (const route of WALLET_ROUTES) {
    test(`${route.path} shows the connect panel`, async ({ page, consoleWatch }) => {
      const response = await page.goto(route.path);
      expect(response?.status(), "HTTP status").toBe(200);
      await expect(page).toHaveTitle(route.title);
      await expectConnectPanel(page);
      // The shell still renders: the top bar offers to connect.
      await expect(page.getByRole("banner").getByRole("button", { name: /^Connect/ })).toBeVisible();
      await settle(page);
      await expectOneH1(page, route.heading);
      await expectNoHorizontalScroll(page);
      consoleWatch.expectClean();
    });
  }
});

test.describe("unknown URLs", () => {
  for (const path of ["/no-such-page", "/chains/not-a-chain", "/governance/cosmoshub-4/not-a-number", "/validators/not-an-address"]) {
    test(`${path} answers 404`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(404);
    });
  }
});
