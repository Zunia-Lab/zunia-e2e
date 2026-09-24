import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { chromium, expect, test, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { CSP_PAGES, probeProvider, startCspPages } from "./support/csp-pages";
import { CSP_PORT, DAPP_URL, EXTENSION_DIR, TEST_PASSWORD, TEST_PHRASE } from "./support/env";
import { base64ToBytes, serializeAminoSignDoc } from "./support/sdk";

/**
 * The unpacked Chromium build (the same code ships to Chrome, Edge and Brave)
 * against the SDK's example dApp: restore a wallet, connect, sign in, sign,
 * then switch accounts and revoke the site from the wallet and watch the page
 * hear about it.
 */

test.describe.configure({ mode: "serial" });

const CHAIN = "osmo-test-5";

let context: BrowserContext;
let extensionId: string;
let dapp: Page;
let firstAddress: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
});

async function openExtension(path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  return page;
}

/** The connect prompt the extension draws over the page, in its own frame. */
async function connectPrompt(page: Page): Promise<Frame> {
  let frame: Frame | undefined;
  await expect
    .poll(() => (frame = page.frames().find((candidate) => candidate.url().includes("/connect.html"))))
    .toBeTruthy();
  return frame!;
}

/**
 * Answers a signing request from the approval queue. The extension raises its
 * toolbar popup, which Playwright cannot drive, so the test opens the same
 * queue in a tab, as the toolbar button would.
 */
async function approveInWallet(expectText: RegExp, button: RegExp): Promise<void> {
  const queue = await openExtension("popup.html?approve=1");
  await expect(queue.getByText(expectText).first()).toBeVisible();
  const password = queue.getByLabel("Password to sign");
  if (await password.isVisible()) await password.fill(TEST_PASSWORD);
  await queue.getByRole("button", { name: button }).click();
}

function logEntry(kind: string) {
  return dapp.locator(`[data-testid="event-log"] li[data-kind="${kind}"]`);
}

test("restores the test wallet", async () => {
  const page = await openExtension("onboarding.html");
  await page.getByLabel("I will never share my recovery phrase with anyone.").check();
  await page.getByLabel(/I accept that Zunia cannot recover a lost phrase/).check();
  await page.getByRole("button", { name: "Restore with phrase" }).click();
  await page.getByPlaceholder(/word1 word2/).fill(TEST_PHRASE);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Wallet name").fill("E2E");
  await page.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD);
  await page.getByLabel("Confirm password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /^Restore wallet/ }).click();
  await expect(page.getByText("Wallet ready")).toBeVisible({ timeout: 30_000 });
  await page.close();
});

test("loads the WASM signing kernel", async () => {
  const page = await openExtension("popup.html");
  const status = await page.evaluate(() =>
    (
      globalThis as unknown as {
        chrome: { runtime: { sendMessage: (message: unknown) => Promise<{ data?: { flavor?: string } }> } };
      }
    ).chrome.runtime.sendMessage({ type: "KERNEL_STATUS" }),
  );
  expect(status.data?.flavor).toBe("wasm");
  await page.close();
});

test("opening the wallet restarts the auto-lock timer", async () => {
  const lockAt = async () => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    return worker.evaluate(async () => {
      const { alarms } = (
        globalThis as unknown as {
          chrome: { alarms: { get: (name: string) => Promise<{ scheduledTime: number } | undefined> } };
        }
      ).chrome;
      return (await alarms.get("zunia-autolock"))?.scheduledTime ?? 0;
    });
  };
  const before = await lockAt();
  expect(before).toBeGreaterThan(0);
  const page = await openExtension("popup.html");
  await expect.poll(lockAt).toBeGreaterThan(before);
  await page.close();
});

test("reaches pages whose CSP blocks injected scripts", async () => {
  const server = await startCspPages(CSP_PORT);
  try {
    for (const path of Object.keys(CSP_PAGES)) {
      const page = await context.newPage();
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

test("connects from the example dApp", async () => {
  dapp = await context.newPage();
  await dapp.goto(DAPP_URL);
  await dapp.getByTestId("connect-extension").click();

  const prompt = await connectPrompt(dapp);
  await expect(prompt.getByText(new URL(DAPP_URL).host)).toBeVisible();
  await prompt.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(dapp.getByTestId("status")).toHaveText("connected");
  await expect(dapp.getByTestId("transport")).toHaveText("extension");
  firstAddress = (await dapp.getByTestId("address").first().innerText()).trim();
  expect(firstAddress).toMatch(/^osmo1[02-9ac-hj-np-z]{38}$/);
});

test("signs in, and the example's server verifies it", async () => {
  await dapp.getByTestId("sign-in").click();
  await approveInWallet(/Sign-in request/, /^Sign in$/);
  await expect(dapp.getByTestId("sign-in-result")).toContainText(`Signed in as ${firstAddress}`);
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
    ({ chainId, signer, doc }) =>
      (window as unknown as { zunia: { signAmino: (...args: unknown[]) => Promise<unknown> } }).zunia.signAmino(
        chainId,
        signer,
        doc,
      ),
    { chainId: CHAIN, signer: firstAddress, doc: signDoc },
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
  const before = await logEntry("accountsChanged").count();
  const wallet = await openExtension("popup.html");
  await wallet.getByRole("button", { name: "Switch account" }).click();
  await wallet.getByRole("button", { name: "Add account" }).click();
  // Adding an account does not switch to it.
  await wallet.getByRole("button", { name: "Switch account" }).click();
  await wallet.getByRole("button", { name: /Account 2/ }).click();

  await expect
    .poll(async () => (await dapp.getByTestId("address").first().innerText()).trim())
    .not.toBe(firstAddress);
  await expect.poll(() => logEntry("accountsChanged").count()).toBeGreaterThan(before);
  await wallet.close();
});

test("revoking the site in the wallet disconnects the page live", async () => {
  const wallet = await openExtension("popup.html");
  await wallet.getByRole("button", { name: "Menu" }).click();
  await wallet.getByRole("button", { name: /Connected dApps/ }).click();
  await wallet.getByRole("button", { name: "Disconnect" }).first().click();

  await expect(dapp.getByTestId("status")).toHaveText("disconnected");
  await expect(logEntry("disconnect").first()).toBeVisible();
  await wallet.close();
});
