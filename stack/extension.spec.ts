import { chromium, expect, test, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { adr36SignDoc } from "../signing/amino-json";
import { loadReference, type TestKey } from "../signing/cases";
import { refusalNaming } from "../signing/expectations";
import { CSP_PAGES, probeProvider, startCspPages } from "./support/csp-pages";
import { ADDED_PHRASE, CSP_PORT, DAPP_URL, EXTENSION_DIR, TEST_PASSWORD, TEST_PHRASE } from "./support/env";
import {
  ESCAPED_MEMO,
  XCS,
  aminoSignatureVerifies,
  contractCallDoc,
  expectProviderIdentity,
  grantDoc,
  manifestVersion,
  readIdentity,
  verifies,
  type DirectDocArgs,
  type StdSignature,
} from "./support/signing";

/**
 * The unpacked Chromium build (the same code ships to Chrome, Edge and Brave)
 * against the SDK's example dApp: restore a wallet, connect, sign in, sign in
 * both modes, add an account with its own phrase and sign from it, then revoke
 * the site from the wallet and watch the page hear about it.
 *
 * Every signature is checked over the bytes the chain rebuilds. The memo with
 * & < >, the direct contract call, the refusal that names its type, the
 * provider identity and the added account's signatures are what 0.1.5 fixed:
 * a 0.1.4 build fails those tests.
 */

test.describe.configure({ mode: "serial" });

const CHAIN = "osmo-test-5";

let context: BrowserContext;
let extensionId: string;
let dapp: Page;
let firstAddress: string;
let firstKey: TestKey;
let addedKey: TestKey;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
  // osmo-test-5 derives with coin type 118 and the osmo prefix, as osmosis-1 does.
  const reference = await loadReference();
  firstKey = reference.keys.main.osmo;
  addedKey = reference.keys.added.osmo;
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

/**
 * Approves `request` once its prompt is in the queue. A wallet that refuses
 * before any prompt fails the test with its own words rather than a timeout.
 */
async function signThroughWallet<T>(request: Promise<T>, expectText: RegExp): Promise<T> {
  const settled = request.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const queue = await openExtension("popup.html?approve=1");
  const prompted = queue
    .getByText(expectText)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => "prompted" as const)
    .catch(() => "no prompt" as const);
  const first = await Promise.race([settled, prompted]);
  if (first === "no prompt") throw new Error(`No prompt matching ${expectText} reached the wallet's queue`);
  if (first !== "prompted") {
    if ("error" in first) throw new Error(`The wallet answered before any prompt: ${String((first.error as Error)?.message ?? first.error)}`);
    return first.value;
  }
  const password = queue.getByLabel("Password to sign");
  if (await password.isVisible()) await password.fill(TEST_PASSWORD);
  await queue.getByRole("button", { name: /^(Approve|Sign)$/ }).click();
  const result = await settled;
  if ("error" in result) throw result.error;
  return result.value;
}

function logEntry(kind: string) {
  return dapp.locator(`[data-testid="event-log"] li[data-kind="${kind}"]`);
}

/** Asks the page's provider to sign an amino document, in the page. */
function signAminoFromPage(signer: string, doc: unknown): Promise<{ signed: unknown; signature: StdSignature }> {
  return dapp.evaluate(
    ({ chainId, address, signDoc }) =>
      (window as unknown as { zunia: { signAmino: (...args: unknown[]) => Promise<{ signed: unknown; signature: StdSignature }> } }).zunia.signAmino(
        chainId,
        address,
        signDoc,
      ),
    { chainId: CHAIN, address: signer, signDoc: doc },
  );
}

/** Asks the page's provider to sign a direct document, in the page; bytes come back as arrays. */
function signDirectFromPage(signer: string, doc: DirectDocArgs) {
  return dapp.evaluate(
    async ({ address, args }) => {
      const zunia = (
        window as unknown as {
          zunia: {
            signDirect: (
              chainId: string,
              signer: string,
              doc: unknown,
            ) => Promise<{ signed: { bodyBytes: Uint8Array; authInfoBytes: Uint8Array }; signature: StdSignature }>;
          };
        }
      ).zunia;
      const answer = await zunia.signDirect(args.chainId, address, {
        ...args,
        bodyBytes: Uint8Array.from(args.bodyBytes),
        authInfoBytes: Uint8Array.from(args.authInfoBytes),
      });
      return {
        signature: answer.signature,
        bodyBytes: Array.from(answer.signed.bodyBytes),
        authInfoBytes: Array.from(answer.signed.authInfoBytes),
      };
    },
    { address: signer, args: doc },
  );
}

function sendDoc(address: string) {
  return {
    chain_id: CHAIN,
    account_number: "0",
    sequence: "0",
    fee: { amount: [{ denom: "uosmo", amount: "2500" }], gas: "100000" },
    msgs: [{ type: "cosmos-sdk/MsgSend", value: { from_address: address, to_address: address, amount: [{ denom: "uosmo", amount: "1" }] } }],
    memo: ESCAPED_MEMO,
  };
}

test("restores the test wallet", async () => {
  const page = await openExtension("onboarding.html");
  await page.getByLabel("I will never share my recovery phrase with anyone.").check();
  await page.getByLabel(/I accept that Zunia cannot recover a lost phrase/).check();
  await page.getByRole("button", { name: "Restore with phrase" }).click();
  await page.getByPlaceholder(/word1 word2/).fill(TEST_PHRASE);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Account name").fill("E2E");
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
  expect(firstAddress).toBe(firstKey.address);
});

test("tells sites which build it is and what it signs", async () => {
  expectProviderIdentity(await dapp.evaluate(readIdentity), manifestVersion(EXTENSION_DIR));
});

test("signs in, and the example's server verifies it", async () => {
  await dapp.getByTestId("sign-in").click();
  await approveInWallet(/Sign-in request/, /^Sign in$/);
  await expect(dapp.getByTestId("sign-in-result")).toContainText(`Signed in as ${firstAddress}`);
});

test("signs an Amino transaction whose memo holds & < >, over the bytes the chain rebuilds", async () => {
  const doc = sendDoc(firstAddress);
  const result = await signThroughWallet(signAminoFromPage(firstAddress, doc), /Send 1 uosmo/);
  expect(result.signed).toEqual(doc);
  expect(aminoSignatureVerifies(result.signed, result.signature, firstKey.pubkey)).toBe(true);
});

test("signs a Direct contract call on a 32-byte contract", async () => {
  const { args, signBytes } = contractCallDoc({ chainId: CHAIN, sender: firstAddress, pubkey: firstKey.pubkey });
  const result = await signThroughWallet(signDirectFromPage(firstAddress, args), /Execute "recover"/);
  expect(result.bodyBytes).toEqual(args.bodyBytes);
  expect(result.authInfoBytes).toEqual(args.authInfoBytes);
  expect(verifies(result.signature.signature, signBytes, firstKey.pubkey)).toBe(true);
});

test("the SDK's getOfflineSignerFor signs a contract call through the extension", async () => {
  const hooked = await dapp.evaluate(() => Boolean((window as unknown as { zuniaExample?: { session?: unknown } }).zuniaExample?.session));
  test.skip(!hooked, "The example dApp exposes window.zuniaExample from zunia-sdk 0.1.1 (dev builds only).");
  const direct = contractCallDoc({ chainId: CHAIN, sender: firstAddress, pubkey: firstKey.pubkey, memo: "Recover" });
  const amino = {
    chain_id: CHAIN,
    account_number: "0",
    sequence: "0",
    fee: { amount: [{ denom: "uosmo", amount: "5000" }], gas: "250000" },
    msgs: [{ type: "wasm/MsgExecuteContract", value: { sender: firstAddress, contract: XCS, msg: { recover: {} }, funds: [] } }],
    memo: "Recover",
  };
  const signing = dapp.evaluate(
    async ({ chainId, address, contract, directDoc, aminoDoc }) => {
      type Answer = { signature: StdSignature; signed: { bodyBytes?: Uint8Array; authInfoBytes?: Uint8Array } };
      const session = (
        window as unknown as {
          zuniaExample: {
            session: {
              getOfflineSignerFor(
                chainId: string,
                options: { messages: unknown[]; memo?: string },
              ): { signDirect?: (signer: string, doc: unknown) => Promise<Answer>; signAmino: (signer: string, doc: unknown) => Promise<Answer> };
            };
          };
        }
      ).zuniaExample.session;
      const message = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: { sender: address, contract, msg: new TextEncoder().encode('{"recover":{}}'), funds: [] },
      };
      const signer = session.getOfflineSignerFor(chainId, { messages: [message], memo: "Recover" });
      if (typeof signer.signDirect === "function") {
        const answer = await signer.signDirect(address, {
          bodyBytes: Uint8Array.from(directDoc.bodyBytes),
          authInfoBytes: Uint8Array.from(directDoc.authInfoBytes),
          chainId,
          accountNumber: BigInt(directDoc.accountNumber),
        });
        return { mode: "direct" as const, signature: answer.signature, signed: null };
      }
      const answer = await signer.signAmino(address, aminoDoc);
      return { mode: "amino" as const, signature: answer.signature, signed: answer.signed as unknown };
    },
    { chainId: CHAIN, address: firstAddress, contract: XCS, directDoc: direct.args, aminoDoc: amino },
  );
  const result = await signThroughWallet(signing, /recover/);
  test.info().annotations.push({ type: "sign mode", description: result.mode });
  if (result.mode === "direct") expect(verifies(result.signature.signature, direct.signBytes, firstKey.pubkey)).toBe(true);
  else expect(aminoSignatureVerifies(result.signed, result.signature, firstKey.pubkey)).toBe(true);
});

test("refuses a message it cannot read, and names its type", async () => {
  const { args } = grantDoc({ chainId: CHAIN, sender: firstAddress, pubkey: firstKey.pubkey });
  const answer = await dapp.evaluate(
    ({ address, doc }) => {
      const zunia = (window as unknown as { zunia: { signDirect: (...values: unknown[]) => Promise<unknown> } }).zunia;
      const call = zunia
        .signDirect(doc.chainId, address, { ...doc, bodyBytes: Uint8Array.from(doc.bodyBytes), authInfoBytes: Uint8Array.from(doc.authInfoBytes) })
        .then(
          () => ({ refused: false, code: "", message: "signed" }),
          (error: { code?: string; message?: string }) => ({ refused: true, code: String(error?.code), message: String(error?.message) }),
        );
      const prompted = new Promise<{ refused: boolean; code: string; message: string }>((resolve) =>
        setTimeout(() => resolve({ refused: false, code: "", message: "a prompt opened" }), 10_000),
      );
      return Promise.race([call, prompted]);
    },
    { address: firstAddress, doc: args },
  );
  expect(answer).toEqual({ refused: true, code: "UNSUPPORTED", message: refusalNaming(["/cosmos.authz.v1beta1.MsgGrant"]) });
});

test("adds an account with its own phrase, and the switch reaches the page live", async () => {
  const before = await logEntry("accountsChanged").count();
  const wallet = await openExtension("popup.html");
  await wallet.getByRole("button", { name: "Switch account" }).click();
  await wallet.getByRole("button", { name: "Add account" }).click();
  await wallet.getByRole("button", { name: "Restore with phrase" }).click();
  await wallet.getByPlaceholder(/word1 word2/).fill(ADDED_PHRASE);
  await wallet.getByRole("button", { name: "Continue" }).click();
  await wallet.getByLabel("Account name").fill("Own phrase");
  await wallet.getByRole("button", { name: "Continue" }).click();
  await wallet.getByRole("button", { name: /^Add account · \d+$/ }).click();
  await wallet.close();

  // Adding an account does not switch to it: pick it, as a user would.
  const home = await openExtension("popup.html");
  await home.getByRole("button", { name: "Switch account" }).click();
  await home.getByRole("button", { name: /Own phrase/ }).click();

  await expect.poll(async () => (await dapp.getByTestId("address").first().innerText()).trim()).toBe(addedKey.address);
  await expect.poll(() => logEntry("accountsChanged").count()).toBeGreaterThan(before);
  await home.close();
});

test("signs from the added account with its own key: sign-in, and Amino with & < >", async () => {
  await dapp.getByTestId("sign-in").click();
  await approveInWallet(/Sign-in request/, /^Sign in$/);
  await expect(dapp.getByTestId("sign-in-result")).toContainText(`Signed in as ${addedKey.address}`);

  const doc = sendDoc(addedKey.address);
  const result = await signThroughWallet(signAminoFromPage(addedKey.address, doc), /Send 1 uosmo/);
  expect(result.signed).toEqual(doc);
  expect(result.signature.pub_key.value).toBe(Buffer.from(addedKey.pubkey).toString("base64"));
  expect(aminoSignatureVerifies(result.signed, result.signature, addedKey.pubkey)).toBe(true);

  const arbitrary = await signThroughWallet(
    dapp.evaluate(
      ({ chainId, address }) =>
        (window as unknown as { zunia: { signArbitrary: (...args: unknown[]) => Promise<StdSignature> } }).zunia.signArbitrary(
          chainId,
          address,
          "Zunia e2e: added account",
        ),
      { chainId: CHAIN, address: addedKey.address },
    ),
    /Zunia e2e: added account/,
  );
  expect(aminoSignatureVerifies(adr36SignDoc(addedKey.address, new TextEncoder().encode("Zunia e2e: added account")), arbitrary, addedKey.pubkey)).toBe(true);
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
