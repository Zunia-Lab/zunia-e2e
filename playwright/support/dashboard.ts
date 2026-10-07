/**
 * Shared fixtures and checks for the dashboard suite (wallet.zunialab.com).
 *
 * Every spec imports `test` and `expect` from here, not from @playwright/test:
 *
 * - `test` skips itself when nothing answers at E2E_BASE_URL (a CI run without
 *   a preview, a laptop without `pnpm dev`), probed once per worker. Set
 *   E2E_REQUIRE_DASHBOARD=1 to fail instead, where a skip would hide an
 *   outage.
 * - `page` fails any test on an uncaught exception or unhandled rejection.
 * - `consoleWatch` collects console errors and uncaught exceptions from the
 *   moment the page opens. Live-data noise is told apart from bugs: a logo
 *   that 404s on a third-party host, or a same-origin `/api/*` answering 429
 *   or 5xx because a public node is down, is recorded as an annotation (the
 *   page is built to say so), while anything else fails the test.
 *
 * The checks below assert shapes (one h1, no sideways scroll, a connect panel),
 * never live values: balances, prices and validator sets change every block.
 */

import { test as base, expect, type ConsoleMessage, type Locator, type Page } from "@playwright/test";

export { expect };

/* ------------------------------------------------------------------ reachability */

interface Reachability {
  ok: boolean;
  reason: string;
}

/** Gateway errors mean the app is not behind the proxy; any other answer means it is. */
const GATEWAY_DOWN = new Set([502, 503, 504]);

async function probe(baseURL: string): Promise<Reachability> {
  // The liveness probe answers from the process alone (no upstream reads), so
  // a slow public node never makes the whole suite skip.
  const url = new URL("/api/health?live=1", baseURL);
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (GATEWAY_DOWN.has(res.status)) return { ok: false, reason: `${url.origin} answered ${res.status}` };
    return { ok: true, reason: "" };
  } catch (error) {
    return { ok: false, reason: `${url.origin} is unreachable (${error instanceof Error ? error.message : String(error)})` };
  }
}

/* ------------------------------------------------------------------ console */

export interface ConsoleWatch {
  /** Problems that fail `expectClean()`. */
  readonly errors: string[];
  /** Live-data noise, attached to the report as an annotation. */
  readonly tolerated: string[];
  /** Fails with every console error and uncaught exception seen so far. */
  expectClean(): void;
}

const FAILED_RESOURCE = /^Failed to load resource/;
/** Live upstream trouble a page is designed to show: rate limits and outages. */
const LIVE_STATUS = /status of (429|5\d\d)\b/;

function classify(message: ConsoleMessage, origin: string): "error" | "tolerated" {
  const text = message.text();
  if (!FAILED_RESOURCE.test(text)) return "error";
  const resource = message.location().url;
  let url: URL | null = null;
  try {
    url = new URL(resource);
  } catch {
    return "error";
  }
  // Chain and validator logos come from many hosts (GitHub, Keybase, token
  // lists); one that is gone is the host's problem and the UI falls back.
  if (url.origin !== origin) return "tolerated";
  if (url.pathname.startsWith("/api/") && LIVE_STATUS.test(text)) return "tolerated";
  // A request cut short by a navigation is not a failure.
  if (/net::ERR_ABORTED/.test(text)) return "tolerated";
  return "error";
}

function watchConsole(page: Page, origin: string): ConsoleWatch {
  const errors: string[] = [];
  const tolerated: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const line = `${message.text().slice(0, 300)}${message.location().url ? ` (${message.location().url.slice(0, 160)})` : ""}`;
    (classify(message, origin) === "error" ? errors : tolerated).push(line);
  });
  page.on("pageerror", (error) => {
    errors.push(`Uncaught ${error.name}: ${error.message.slice(0, 300)}`);
  });
  return {
    errors,
    tolerated,
    expectClean() {
      expect([...new Set(errors)], "console errors and uncaught exceptions").toEqual([]);
    },
  };
}

/* ------------------------------------------------------------------ fixtures */

interface TestFixtures {
  /** Auto: skips the test when the dashboard is not reachable. */
  requireDashboard: void;
  consoleWatch: ConsoleWatch;
}

interface WorkerFixtures {
  dashboardReachability: Reachability;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Every test's page fails it on an uncaught exception (an error the
  // dashboard never handled, a rejected promise nobody awaited): those are
  // bugs whatever the test is about. Console errors are `consoleWatch`'s.
  page: async ({ page }, use) => {
    const uncaught: string[] = [];
    page.on("pageerror", (error) => uncaught.push(`${error.name}: ${error.message.slice(0, 300)} (${page.url()})`));
    await use(page);
    expect([...new Set(uncaught)], "uncaught exceptions in the page").toEqual([]);
  },
  dashboardReachability: [
    async ({}, use, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL;
      const result = baseURL ? await probe(baseURL) : { ok: false, reason: "No baseURL configured (set E2E_BASE_URL)" };
      if (!result.ok && process.env.E2E_REQUIRE_DASHBOARD === "1") {
        throw new Error(`Dashboard required but not reachable: ${result.reason}`);
      }
      await use(result);
    },
    { scope: "worker" },
  ],
  requireDashboard: [
    async ({ dashboardReachability }, use, testInfo) => {
      testInfo.skip(
        !dashboardReachability.ok,
        `Dashboard not reachable: ${dashboardReachability.reason}. Set E2E_BASE_URL to a running dashboard (pnpm dev, a preview, production).`,
      );
      await use();
    },
    { auto: true },
  ],
  consoleWatch: async ({ page, baseURL }, use, testInfo) => {
    const watch = watchConsole(page, new URL(baseURL ?? "http://127.0.0.1").origin);
    await use(watch);
    if (watch.tolerated.length > 0) {
      testInfo.annotations.push({ type: "console (live data, tolerated)", description: [...new Set(watch.tolerated)].join("\n") });
    }
  },
});

/* ------------------------------------------------------------------ viewports */

/** A phone (390 × 844, touch), the width the no-sideways-scroll rule is checked at. */
export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } as const;

/** Desktop with the rail, the sidebar and every top-bar control (≥ 1280 px). */
export const DESKTOP = { viewport: { width: 1280, height: 900 } } as const;

/* ------------------------------------------------------------------ checks */

/**
 * Lets the page finish its first reads: network idle when it comes (pages
 * that poll still go quiet between polls), never more than `maxMs`.
 */
export async function settle(page: Page, maxMs = 8_000): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: maxMs }).catch(() => undefined);
}

/** Exactly one h1 in the document, with text (and the given text, when named). */
export async function expectOneH1(page: Page, name?: string | RegExp): Promise<void> {
  // Light DOM only: Next's dev overlay lives in a shadow root.
  const headings = await page.evaluate(() =>
    Array.from(document.querySelectorAll("h1"), (h) => (h.textContent ?? "").replace(/\s+/g, " ").trim()),
  );
  expect(headings, "h1 elements on the page").toHaveLength(1);
  expect(headings[0], "the h1 has text").not.toBe("");
  if (typeof name === "string") expect(headings[0]).toBe(name);
  else if (name) expect(headings[0]).toMatch(name);
}

/** The page cannot be scrolled sideways (names the widest offenders when it can). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const doc = document.documentElement;
    const width = doc.clientWidth;
    const offenders =
      doc.scrollWidth > width + 1
        ? Array.from(document.body.querySelectorAll<HTMLElement>("*"))
            .filter((el) => el.getBoundingClientRect().right > width + 1)
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.className).slice(0, 80)}`)
        : [];
    return { scrollWidth: doc.scrollWidth, clientWidth: width, offenders };
  });
  expect(result.scrollWidth, `page wider than the viewport; widest elements: ${result.offenders.join(" | ")}`).toBeLessThanOrEqual(
    result.clientWidth + 1,
  );
}

/**
 * A wallet page without a wallet: the in-page connect panel (the two browser
 * wallets, then the Zunia Mobile zone) instead of the page's content.
 *
 * An extension the browser does not have offers its install page (a link);
 * a detected one connects (a button). Pass `keplr: "detected"` when the mock
 * wallet is installed.
 */
export async function expectConnectPanel(page: Page, options: { keplr?: "absent" | "detected" } = {}): Promise<void> {
  const main = page.getByRole("main");
  await expect(main.getByRole("button", { name: /Zunia Mobile/ })).toBeVisible({ timeout: 20_000 });
  await expect(main.getByText("Non-custodial: every transaction is approved in your wallet or on your phone.")).toBeVisible();
  await expect(main.getByRole("link", { name: /Zunia extension/ })).toBeVisible();
  if (options.keplr === "detected") {
    await expect(main.getByRole("button", { name: /^Keplr/ })).toContainText("Detected");
  } else {
    await expect(main.getByRole("link", { name: /Keplr/ })).toBeVisible();
  }
}

/** The connected account's chip in the top bar ("Account: <name>, <address>"). */
export function accountChip(page: Page): Locator {
  return page.getByRole("button", { name: /^Account:/ });
}

/** Waits until the wallet (a restored or a fresh connection) is linked. */
export async function waitForAccount(page: Page): Promise<void> {
  await expect(accountChip(page)).toBeVisible({ timeout: 30_000 });
}

/** Whether a click at the centre of `locator` reaches it (not an element above, not pointer-events: none). */
export async function receivesPointer(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  });
}

/** `content` of every `<meta name="robots">` in an HTML document. */
export function robotsMeta(html: string): string[] {
  const tags = html.match(/<meta\b[^>]*\bname="robots"[^>]*>/gi) ?? [];
  return tags.map((tag) => /\bcontent="([^"]*)"/i.exec(tag)?.[1] ?? "");
}

/** `href` of `<link rel="canonical">` in an HTML document, or null. */
export function canonicalLink(html: string): string | null {
  const tag = (html.match(/<link\b[^>]*\brel="canonical"[^>]*>/gi) ?? [])[0];
  return tag ? (/\bhref="([^"]*)"/i.exec(tag)?.[1] ?? null) : null;
}
