import { existsSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { expect, test } from "@playwright/test";
import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer-core";
import { CSP_PAGES, probeProvider, startCspPages } from "./support/csp-pages";
import { CSP_PORT, DAPP_URL, FIREFOX_BIN, FIREFOX_EXTENSION_DIR, TEST_PASSWORD, TEST_PHRASE } from "./support/env";
import { base64ToBytes, serializeAminoSignDoc } from "./support/sdk";

/**
 * The Firefox build through the same story as extension.spec.ts. Playwright's
 * Firefox cannot load extensions, so puppeteer-core drives a stock Firefox over
 * WebDriver BiDi and Playwright only runs the tests. Firefox has no
 * IntersectionObserver v2, so the extension never draws its in-page connect
 * prompt there: the request waits in the toolbar popup, as it would for a user.
 */

test.describe.configure({ mode: "serial" });
test.skip(!existsSync(FIREFOX_BIN), `No Firefox at ${FIREFOX_BIN}. Set FIREFOX_BIN to run this spec.`);

const CHAIN = "osmo-test-5";
/** Pinned through a pref so the extension's pages have a known address. */
const UUID = "d2f3e0a1-0000-4000-8000-000000000001";
/**
 * Firefox unloads an idle background page after 30 s. Shorter here, so the run
 * also covers the extension coming back from that between steps.
 */
const BACKGROUND_IDLE_MS = 5_000;

let browser: Browser;
let dapp: Page;
let firstAddress: string;

test.beforeAll(async () => {
  browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: FIREFOX_BIN,
    headless: process.env.HEADED !== "1",
    // WebDriver BiDi only opens moz-extension:// pages with system access.
    args: ["--remote-allow-system-access"],
    extraPrefsFirefox: {
      "extensions.webextensions.uuids": JSON.stringify({ "extension@zunialab.com": UUID }),
      "extensions.background.idle.timeout": BACKGROUND_IDLE_MS,
    },
  });
  await browser.installExtension(FIREFOX_EXTENSION_DIR);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openExtension(path: string): Promise<Page> {
  const page = await browser.newPage();
  const url = `moz-extension://${UUID}/${path}`;
  // Firefox moves the tab into the extension process and puppeteer never hears
  // that navigation finish, so wait for the document instead.
  page.goto(url, { timeout: 0 }).catch(() => undefined);
  await expect
    .poll(() => page.evaluate(() => `${location.href} ${document.readyState}`).catch(() => ""), { timeout: 20_000 })
    .toBe(`${url} complete`);
  return page;
}

/** The first visible, enabled element under `selector` whose label matches `name`. */
async function find(page: Page, selector: string, name: RegExp): Promise<ElementHandle<HTMLElement>> {
  const handle = await page.waitForFunction(
    (css: string, source: string, flags: string) => {
      const pattern = new RegExp(source, flags);
      const matches = (element: HTMLElement) => {
        const input = element as HTMLInputElement;
        const names = [
          element.getAttribute("aria-label"),
          input.placeholder,
          ...Array.from(input.labels ?? [], (label) => label.textContent),
          element.matches("input, textarea") ? null : element.textContent,
        ];
        return names.some((label) => label != null && pattern.test(label.trim()));
      };
      return (
        Array.from(document.querySelectorAll<HTMLElement>(css)).find(
          (element) =>
            element.getClientRects().length > 0 && !(element as HTMLButtonElement).disabled && matches(element),
        ) ?? null
      );
    },
    { timeout: 30_000 },
    selector,
    name.source,
    name.flags,
  );
  return handle as unknown as ElementHandle<HTMLElement>;
}

// Firefox refuses WebDriver input in extension pages ("privileged scope"), so
// clicks and typing go through DOM events, which React handles the same way.

async function click(page: Page, selector: string, name: RegExp): Promise<void> {
  await (await find(page, selector, name)).evaluate((element) => element.click());
}

async function fill(page: Page, name: RegExp, value: string): Promise<void> {
  await (await find(page, "input, textarea", name)).evaluate((element, text) => {
    const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setValue?.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

/** Matches the text as written: Firefox's innerText applies CSS text-transform. */
async function waitForText(page: Page, text: string | RegExp): Promise<void> {
  const pattern = typeof text === "string" ? text : text.source;
  await page.waitForFunction(
    (source: string, literal: boolean) => {
      const content = document.body.textContent ?? "";
      return literal ? content.includes(source) : new RegExp(source).test(content);
    },
    { timeout: 30_000 },
    pattern,
    typeof text === "string",
  );
}

/** The element's text, or "" until it renders, so expect.poll keeps waiting. */
async function testId(page: Page, id: string): Promise<string> {
  const element = await page.$(`[data-testid="${id}"]`);
  return element ? element.evaluate((node) => (node.textContent ?? "").trim()) : "";
}

function logCount(kind: string): Promise<number> {
  return dapp.$$eval(`[data-testid="event-log"] li[data-kind="${kind}"]`, (items) => items.length);
}

/** Answers the oldest request in the toolbar popup's queue, opened in a tab. */
async function approveInWallet(expectText: RegExp, button: RegExp): Promise<void> {
  const queue = await openExtension("popup.html?approve=1");
  await waitForText(queue, expectText);
  if (await queue.$('input[aria-label="Password to sign"]')) await fill(queue, /^Password to sign$/, TEST_PASSWORD);
  await click(queue, "button", button);
  await queue.close();
}

/**
 * When the extension's background page last started, and whether the wallet is
 * unlocked. The wallet opens its toolbar popup for dApp requests. A user closes
 * it by clicking away, but headless Firefox leaves it open, and an open popup
 * keeps the background page loaded on purpose, so a test about idling can ask
 * to close it first.
 */
async function backgroundState({ closeToolbarPopup = false } = {}): Promise<{ startedAt: number; unlocked: boolean }> {
  const page = await openExtension("popup.html");
  const state = await page.evaluate(async (close: boolean) => {
    const { extension, runtime } = (
      globalThis as unknown as {
        browser: {
          extension: { getViews: (filter: { type: "popup" }) => Window[] };
          runtime: {
            getBackgroundPage: () => Promise<Window>;
            sendMessage: (message: unknown) => Promise<{ data?: { unlocked?: boolean } }>;
          };
        };
      }
    ).browser;
    if (close) for (const view of extension.getViews({ type: "popup" })) view.close();
    const status = await runtime.sendMessage({ type: "GET_STATUS" });
    return {
      startedAt: (await runtime.getBackgroundPage()).performance.timeOrigin,
      unlocked: status.data?.unlocked === true,
    };
  }, closeToolbarPopup);
  await page.close();
  return state;
}

test("loads the WASM signing kernel", async () => {
  const page = await openExtension("popup.html");
  const status = await page.evaluate(() =>
    (
      globalThis as unknown as {
        browser: { runtime: { sendMessage: (message: unknown) => Promise<{ data?: { flavor?: string } }> } };
      }
    ).browser.runtime.sendMessage({ type: "KERNEL_STATUS" }),
  );
  expect(status.data?.flavor).toBe("wasm");
  await page.close();
});

test("restores the test wallet", async () => {
  const page = await openExtension("onboarding.html");
  await click(page, "label", /^I will never share my recovery phrase with anyone\./);
  await click(page, "label", /^I accept that Zunia cannot recover a lost phrase/);
  await click(page, "button", /^Restore with phrase$/);
  await fill(page, /^word1 word2/, TEST_PHRASE);
  await click(page, "button", /^Continue$/);
  await fill(page, /^Wallet name/, "E2E");
  await fill(page, /^Password/, TEST_PASSWORD);
  await fill(page, /^Confirm password/, TEST_PASSWORD);
  await click(page, "button", /^Continue$/);
  await click(page, "button", /^Restore wallet/);
  await waitForText(page, "Wallet ready");
  await page.close();
});

test("reaches pages whose CSP blocks injected scripts", async () => {
  const server = await startCspPages(CSP_PORT);
  try {
    for (const path of Object.keys(CSP_PAGES)) {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${CSP_PORT}${path}`);
      expect(await page.evaluate(probeProvider), path).toEqual({
        pageScript: true,
        provider: true,
        connectedChains: [],
      });
      await page.close();
    }
  } finally {
    server.close();
  }
});

test("connects from the example dApp, approved in the toolbar popup", async () => {
  dapp = await browser.newPage();
  await dapp.goto(DAPP_URL);
  await click(dapp, "[data-testid=connect-extension]", /./);
  await approveInWallet(new RegExp(new URL(DAPP_URL).host), /^Approve$/);

  await expect.poll(() => testId(dapp, "status"), { timeout: 20_000 }).toBe("connected");
  expect(await testId(dapp, "transport")).toBe("extension");
  firstAddress = await testId(dapp, "address");
  expect(firstAddress).toMatch(/^osmo1[02-9ac-hj-np-z]{38}$/);
});

test("signs in, and the example's server verifies it", async () => {
  await click(dapp, "[data-testid=sign-in]", /./);
  await approveInWallet(/Sign-in request/, /^Sign in$/);
  await expect.poll(() => testId(dapp, "sign-in-result"), { timeout: 20_000 }).toContain(`Signed in as ${firstAddress}`);
});

test("signs an Amino transaction the page can verify", async () => {
  const signDoc = {
    chain_id: CHAIN,
    account_number: "0",
    sequence: "0",
    fee: { amount: [{ denom: "uosmo", amount: "2500" }], gas: "100000" },
    msgs: [
      {
        type: "cosmos-sdk/MsgSend",
        value: { from_address: firstAddress, to_address: firstAddress, amount: [{ denom: "uosmo", amount: "1" }] },
      },
    ],
    memo: "zunia e2e",
  };
  const signing = dapp.evaluate(
    (chainId: string, signer: string, doc: unknown) =>
      (window as unknown as { zunia: { signAmino: (...args: unknown[]) => Promise<unknown> } }).zunia.signAmino(
        chainId,
        signer,
        doc,
      ),
    CHAIN,
    firstAddress,
    signDoc,
  );
  await approveInWallet(/MsgSend|Send/, /^(Approve|Sign)$/);
  const result = (await signing) as {
    signed: unknown;
    signature: { signature: string; pub_key: { value: string } };
  };

  const digest = sha256(serializeAminoSignDoc(result.signed));
  const valid = secp256k1.verify(
    base64ToBytes(result.signature.signature),
    digest,
    base64ToBytes(result.signature.pub_key.value),
    { prehash: false },
  );
  expect(valid).toBe(true);
});

test("switching accounts in the wallet reaches the page live", async () => {
  const before = await logCount("accountsChanged");
  const wallet = await openExtension("popup.html");
  await click(wallet, "button", /^Switch account$/);
  await click(wallet, "button", /^Add account$/);
  // Adding an account does not switch to it. Reopen the sheet once it has
  // closed, as a user would, and pick the new account.
  await wallet.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10_000 });
  await click(wallet, "button", /^Switch account$/);
  await click(wallet, "button", /Account 2/);

  await expect.poll(() => testId(dapp, "address"), { timeout: 20_000 }).not.toBe(firstAddress);
  await expect.poll(() => logCount("accountsChanged"), { timeout: 20_000 }).toBeGreaterThan(before);
  await wallet.close();
});

test("revoking the site in the wallet disconnects the page live", async () => {
  const wallet = await openExtension("popup.html");
  await click(wallet, "button", /^Menu$/);
  await click(wallet, "button", /Connected dApps/);
  await click(wallet, "button", /^Disconnect$/);

  await expect.poll(() => testId(dapp, "status"), { timeout: 20_000 }).toBe("disconnected");
  expect(await logCount("disconnect")).toBeGreaterThan(0);
  await wallet.close();
});

test("stays unlocked when Firefox unloads the idle background page", async () => {
  const before = await backgroundState({ closeToolbarPopup: true });
  expect(before.unlocked).toBe(true);
  // Nothing talks to the extension now, so Firefox unloads the page.
  await new Promise((resolve) => setTimeout(resolve, BACKGROUND_IDLE_MS * 3));
  const after = await backgroundState();
  expect(after.startedAt).toBeGreaterThan(before.startedAt);
  expect(after.unlocked).toBe(true);
});
