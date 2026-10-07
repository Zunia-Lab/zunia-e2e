/**
 * Regressions and product decisions of the dashboard v2 audit (2026-10-07):
 *
 * - Every kit Select with a placeholder was unclickable: the placeholder's
 *   disabled <option> matched the field frame's `:has(:disabled)`, which set
 *   `pointer-events: none` on it. Staking's Network field is the case that
 *   blocked a flow.
 * - /mobile is not a page any more: a 308 to /?connect=mobile, which opens
 *   the Connect wallet modal on Zunia Mobile.
 * - Zunia Mobile is an option ("zone") of the Connect wallet modal, not a
 *   page, a nav entry or a "pair" button.
 * - Notification preferences live in Settings → Notifications; /notifications
 *   only lists, and its gear links there.
 * - Activity opens on the ten latest rows, then "Load more" (no pages).
 */

import type { Page } from "@playwright/test";
import { DESKTOP, expect, receivesPointer, settle, test, waitForAccount } from "./support/dashboard";
import { ACTIVE_WALLET, RETAIL_WALLET, blockRelay, installMockWallet, signAttempts } from "./support/mock-wallet";
import { MOVED_PAGES } from "./support/routes";

test.use(DESKTOP);

test.describe("moved pages", () => {
  for (const { from, to } of MOVED_PAGES) {
    test(`${from} → ${to} (308)`, async ({ request }) => {
      const response = await request.get(from, { maxRedirects: 0 });
      expect(response.status()).toBe(308);
      const location = new URL(response.headers()["location"] ?? "", "http://origin.invalid");
      expect(`${location.pathname}${location.search}`).toBe(to);
    });
  }

  test("/mobile keeps the query string of an old link", async ({ request }) => {
    const response = await request.get("/mobile?ref=qr", { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    const location = new URL(response.headers()["location"] ?? "", "http://origin.invalid");
    expect(location.pathname).toBe("/");
    expect(location.searchParams.get("connect")).toBe("mobile");
    expect(location.searchParams.get("ref")).toBe("qr");
  });

  test("an old proposal URL (/governance/<id>?chain=) redirects to /governance/<chain>/<id>", async ({ request }) => {
    const response = await request.get("/governance/1?chain=cosmoshub-4", { maxRedirects: 0 });
    expect([307, 308]).toContain(response.status());
    expect(new URL(response.headers()["location"] ?? "", "http://origin.invalid").pathname).toBe("/governance/cosmoshub-4/1");
    // Without a chain the old URL names nothing: a real 404.
    expect((await request.get("/governance/1", { maxRedirects: 0 })).status()).toBe(404);
  });

  test("/mobile lands on the Connect wallet modal's Zunia Mobile view", async ({ context, page }) => {
    await blockRelay(context);
    await page.goto("/mobile");
    const modal = page.getByRole("dialog", { name: "Connect Zunia Mobile" });
    await expect(modal).toBeVisible({ timeout: 20_000 });
    // The parameter is an instruction for one arrival: it leaves the address bar.
    await expect(page).toHaveURL((url) => url.pathname === "/" && !url.searchParams.has("connect"));
    // Back to the wallet list from inside the modal.
    await modal.getByRole("button", { name: "Back to the wallet list" }).click();
    await expect(page.getByRole("dialog", { name: "Connect a wallet" })).toBeVisible();
  });
});

test.describe("Zunia Mobile is a way to connect", () => {
  test("the Connect wallet modal offers it beside the browser wallets", async ({ context, page }) => {
    await blockRelay(context);
    await page.goto("/markets");
    await page.getByRole("banner").getByRole("button", { name: "Connect wallet" }).click();
    const modal = page.getByRole("dialog", { name: "Connect a wallet" });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("link", { name: /Zunia extension/ })).toBeVisible();
    await expect(modal.getByRole("link", { name: /Keplr/ })).toBeVisible();
    const mobile = modal.getByRole("button", { name: /Zunia Mobile/ });
    await expect(mobile).toBeVisible();
    await expect(mobile).toContainText("Beta");
    // A way to connect, not a pairing feature.
    await expect(modal.getByRole("button", { name: /\bpair/i })).toHaveCount(0);
    await expect(modal.getByRole("link", { name: /\bpair/i })).toHaveCount(0);

    await mobile.click();
    const qrView = page.getByRole("dialog", { name: "Connect Zunia Mobile" });
    await expect(qrView).toBeVisible();
    await expect(qrView).toContainText("Scan with the Zunia app");
  });

  test("no navigation entry links to it", async ({ page }) => {
    await page.goto("/markets");
    await expect(page.getByRole("navigation").first()).toBeVisible();
    // Neither in the sidebar nor anywhere else in the frame.
    await expect(page.getByRole("link", { name: /Zunia Mobile/ })).toHaveCount(0);
    await expect(page.locator('a[href="/mobile"]')).toHaveCount(0);
  });

  test("?connect=wallets opens the wallet list", async ({ page }) => {
    await page.goto("/?connect=wallets");
    await expect(page.getByRole("dialog", { name: "Connect a wallet" })).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL((url) => url.pathname === "/" && !url.searchParams.has("connect"));
  });
});

test.describe("Staking", () => {
  test("Stake → the Network select is clickable and leads to the validator picker", async ({ context, page }) => {
    await installMockWallet(context, { addresses: RETAIL_WALLET });
    await page.goto("/staking");
    await waitForAccount(page);

    // All chains in scope: the sheet asks which network to stake on.
    await page.getByRole("region", { name: "Positions" }).getByRole("button", { name: "Stake", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: /^Stake/ });
    await expect(sheet).toBeVisible();
    const network = sheet.getByRole("combobox", { name: "Network" });
    await expect(network).toBeVisible();
    await expect(network).toBeEnabled();
    await expect(network).toHaveValue("");

    // The bug: the frame (and so the select) had pointer-events: none.
    expect(await network.evaluate((el) => getComputedStyle(el).pointerEvents)).not.toBe("none");
    expect(await receivesPointer(network), "a click on the select reaches it").toBe(true);
    await network.click(); // actionability includes "receives pointer events"

    await network.selectOption("cosmoshub-4");
    await expect(network).toHaveValue("cosmoshub-4");
    await expect(sheet).toHaveAccessibleName(/^Stake ATOM/);

    // The validator picker appears, and opens on the chain's bonded set.
    const picker = sheet.locator("#stake-validator");
    await expect(sheet.locator('label[for="stake-validator"]')).toHaveText("Validator");
    await expect(picker).toBeEnabled({ timeout: 45_000 });
    await expect(picker).toContainText("Choose a validator");
    await picker.click();
    const list = page.getByRole("listbox", { name: "Validators on Cosmos Hub" });
    await expect(list.getByRole("option").first()).toBeVisible();
    expect(await signAttempts(page)).toBe(0);
  });
});

test.describe("Notifications", () => {
  test("/notifications lists only; its gear opens Settings → Notifications", async ({ context, page }) => {
    await installMockWallet(context, { addresses: RETAIL_WALLET });
    await page.goto("/notifications");
    await waitForAccount(page);
    const main = page.getByRole("main");
    const center = main.getByRole("region", { name: /^Notification center/ });
    await expect(center).toBeVisible();

    // No preferences block: no channels, kinds, quiet hours or push here.
    for (const text of ["Channels", "Browser alerts", "Push to this device", "What to tell you about", "Quiet hours"]) {
      await expect(main.getByText(text, { exact: true }), text).toHaveCount(0);
    }
    await expect(main.getByRole("switch")).toHaveCount(0);

    // The header's gear, and the empty state's button while nothing came yet
    // (notices derived from the wallet's reads can arrive any moment: read
    // every link at once).
    const gear = center.getByLabel("Notification settings", { exact: true });
    await expect(gear).toHaveAttribute("href", "/settings#notifications");
    const hrefs = await center.getByRole("link", { name: "Notification settings" }).evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    expect(new Set(hrefs)).toEqual(new Set(["/settings#notifications"]));
    await gear.click();
    await expect(page).toHaveURL(/\/settings#notifications$/);
    const preferences = page.getByRole("region", { name: "Notifications", exact: true });
    await expect(preferences).toBeVisible();
    await expect(preferences.getByText("Quiet hours", { exact: true }).first()).toBeVisible();
    await expect(preferences.getByText("Push to this device", { exact: true })).toBeVisible();
  });

  test("old links to /notifications#preferences land in Settings", async ({ page }) => {
    await page.goto("/notifications#preferences");
    await expect(page).toHaveURL(/\/settings#notifications$/, { timeout: 20_000 });
    await expect(page.getByRole("region", { name: "Notifications", exact: true })).toBeVisible();
  });
});

test.describe("Activity", () => {
  const listOf = (page: Page) => page.getByRole("region", { name: "Transactions", exact: true });
  /** Rows the list shows (each row is a link to its transaction). */
  const shownRows = (page: Page) => listOf(page).locator('li > a[href^="/activity/"]').count();

  test("the list opens on the ten latest rows, then Load more adds ten", async ({ context, page }) => {
    test.setTimeout(300_000);
    await installMockWallet(context, { addresses: ACTIVE_WALLET });

    // Every row the API handed this page, keyed the way the list keys them,
    // and the chains whose public node failed a history read. Bodies are read
    // as they come and never awaited: a request the page aborts has none.
    const loaded = new Set<string>();
    const nodeTrouble = new Set<string>();
    page.on("response", (response) => {
      if (new URL(response.url()).pathname !== "/api/activity" || response.status() !== 200) return;
      response
        .json()
        .then((body: { items?: Array<{ chainId: string; address: string; hash: string }>; errors?: Array<{ chainId?: string; scope?: string }> }) => {
          for (const item of body.items ?? []) loaded.add(`${item.chainId}:${item.address}:${item.hash}`);
          for (const error of body.errors ?? []) if (error.scope === "history" && error.chainId) nodeTrouble.add(error.chainId);
        })
        .catch(() => undefined);
    });
    /** The list shows exactly the newest `cap` rows of what is loaded. */
    const expectNewest = (cap: number, timeout: number) =>
      expect(async () => {
        const shown = await shownRows(page);
        expect(shown, `rows shown, of ${loaded.size} loaded`).toBe(Math.min(cap, loaded.size));
      }).toPass({ timeout });

    // All time: every loaded row belongs to the view, so the list must show
    // exactly the newest min(10, loaded) — and each "Load more" ten more.
    await page.goto("/activity?range=all");
    await waitForAccount(page);
    const list = listOf(page);
    await expect(list).toBeVisible();
    // A public node that times out is retried on the page's next refresh
    // (about a minute later), so the first rows may take a cycle.
    const gotRows = await expect
      .poll(() => loaded.size, { timeout: 150_000 })
      .toBeGreaterThan(0)
      .then(
        () => true,
        () => false,
      );
    test.skip(
      !gotRows && nodeTrouble.size > 0,
      `No history could be read: the public nodes of ${[...nodeTrouble].join(", ")} did not answer. Not the rule under test.`,
    );
    expect(gotRows, "the activity API returned rows").toBe(true);
    await expectNewest(10, 30_000);

    const more = list.getByRole("button", { name: "Load more" });
    if (loaded.size <= 10 && !(await more.isVisible())) {
      test.info().annotations.push({ type: "note", description: `Only ${loaded.size} transactions in the nodes' retention: Load more not exercised.` });
    } else {
      await expect(more).toBeVisible();
      // A wallet page, not an explorer: no page numbers.
      const pager = /^(Next|Previous)( page)?$|^Page \d+$/;
      await expect(list.getByRole("button", { name: pager })).toHaveCount(0);
      await expect(list.getByRole("link", { name: pager })).toHaveCount(0);
      await more.click();
      await expectNewest(20, 90_000);
    }

    // The default view (30 days) follows the same rule: never more than ten
    // rows before "Load more", however many the range holds.
    await page.goto("/activity");
    await waitForAccount(page);
    await expect(async () => {
      const rows = await shownRows(page);
      const empty = await listOf(page).getByText(/^(Nothing in|No transactions)/).count();
      expect(rows > 0 || empty > 0, "the list has loaded").toBe(true);
    }).toPass({ timeout: 60_000 });
    // The hook keeps reading older pages until the range is complete; the
    // list must not grow by itself while it does.
    await settle(page, 15_000);
    expect(await shownRows(page)).toBeLessThanOrEqual(10);
    expect(await signAttempts(page)).toBe(0);
  });
});
