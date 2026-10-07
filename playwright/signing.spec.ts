import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { expect, test, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { HUB, fromBech32, toBech32 } from "../signing/cases";
import { MNEMONIC } from "../signing/phrases";
import {
  CHAINS as EXTENSION_CHAINS,
  importWallet,
  launchExtension,
  type ApprovalItem,
  type ExtensionSession,
} from "../signing/browser";
import { verifyTxRaw, type OracleVerdict } from "../signing/oracle";
import { installKeplrSigningMockInto, keplrMockCalls, type KeplrMockChain } from "./support/keplr-signing-mock";
import { DEFAULT_FOLLOWED, RETAIL_WALLET } from "./support/mock-wallet";

/**
 * Tier 2b: the dashboard's own pages sign, with a wallet in the browser, and
 * every transaction they would broadcast is checked the way the chain would
 * (signing/oracle.ts). Wallets:
 *
 * - a Keplr-shaped wallet that signs with CosmJS (support/keplr-signing-mock.ts);
 * - the Zunia extension under test, unpacked (EXT_DIR, the 0.1.5 release candidate);
 * - Zunia 0.1.4, unpacked (EXT_DIR_014), for the legacy policy.
 *
 * Every route that could reach a chain is answered here and fails closed:
 * /api/account, /api/tx/simulate and /api/tx/<hash> are fulfilled, POST
 * /api/broadcast is captured and fulfilled, any other POST that looks like a
 * broadcast is aborted. The pages read balances, positions and proposals of a
 * real public account (RETAIL_WALLET) as if they were the test key's, so the
 * forms have something to spend. Keys come from the public "abandon … about"
 * phrase only.
 *
 * Runs only with E2E_SIGNING=1, and refuses to run against anything but a
 * dashboard on this machine (`pnpm dev` in zunia-dashboard):
 *
 *   E2E_SIGNING=1 E2E_BASE_URL=http://127.0.0.1:3000 EXT_DIR=… EXT_DIR_014=… \
 *     pnpm exec playwright test playwright/signing.spec.ts
 */

const SIGNING = process.env.E2E_SIGNING === "1";
const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
if (SIGNING && !LOCAL_HOSTS.has(new URL(BASE_URL).hostname)) {
  throw new Error(`Refusing to sign against ${BASE_URL}: the signing suite runs against a dashboard on this machine only.`);
}

test.skip(!SIGNING, "Signs real transactions with a test key against a local dashboard: set E2E_SIGNING=1 to run it.");
test.setTimeout(150_000);

/** The account the fulfilled routes report; the oracle verifies against it. */
const ACCOUNT_NUMBER = "12345";
const SEQUENCE = "7";
const FOLLOWED = [...DEFAULT_FOLLOWED];

/** Prefixes and coin types of the chains the dashboard follows by default (its chain catalog). */
const WALLET_CHAINS: Record<string, KeplrMockChain> = {
  "safrochain-1": { prefix: "addr_safro", coinType: 118 },
  "cosmoshub-4": { prefix: "cosmos", coinType: 118 },
  "osmosis-1": { prefix: "osmo", coinType: 118 },
  celestia: { prefix: "celestia", coinType: 118 },
  "akashnet-2": { prefix: "akash", coinType: 118 },
};

/** The abandon key's 20 address bytes, the same behind every prefix (checked against the wallet below). */
const KEY_DATA = fromBech32("cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4").data;

/** The test key's address on a followed chain (coin type 118 everywhere: one key, several prefixes). */
function testAddress(chainId: string): string {
  const chain = WALLET_CHAINS[chainId];
  if (!chain) throw new Error(`No prefix for ${chainId}`);
  return toBech32(chain.prefix, KEY_DATA);
}

/** A 32-byte recipient on the Hub (an interchain account's or a contract's shape). Nobody holds its key. */
const HUB_32_BYTE = toBech32("cosmos", sha256(new TextEncoder().encode("zunia e2e 32-byte recipient")));
/** The account added with its own phrase in the other suites, as a plain recipient here. */
const HUB_RECIPIENT = "cosmos1avgyh77ycn997ja45q5q8ss8y9mr424jq6zn4p";

/* ------------------------------------------------------------------ fail-closed routes */

interface Broadcast {
  chainId: string;
  txBytes: string;
}

/** Swaps the test key's addresses for RETAIL_WALLET's in a query, and back in the answer. */
function retailMap(): Array<[string, string]> {
  return Object.entries(RETAIL_WALLET)
    .filter(([chainId]) => chainId in WALLET_CHAINS)
    .map(([chainId, retail]) => [testAddress(chainId), retail]);
}

async function fulfillAsRetail(route: Route, url: URL): Promise<void> {
  for (const param of ["accounts", "voter", "address"]) {
    let value = url.searchParams.get(param);
    if (value === null) continue;
    for (const [mine, retail] of retailMap()) value = value.split(mine).join(retail);
    url.searchParams.set(param, value);
  }
  // A busy dev server can drop a read: the page shows its own error for it, the test goes on.
  let response: Awaited<ReturnType<Route["fetch"]>>;
  try {
    response = await route.fetch({ url: url.href });
  } catch {
    await route.abort("connectionreset").catch(() => undefined);
    return;
  }
  let body = await response.text();
  for (const [mine, retail] of retailMap()) body = body.split(retail).join(mine);
  await route.fulfill({ response, body });
}

/**
 * Installs the routes on a context. Every POST whose path looks like a
 * broadcast and is not the dashboard's own /api/broadcast is aborted, whatever
 * its host; /api/broadcast itself is captured and answered here.
 */
async function failClosed(context: BrowserContext, captured: Broadcast[]): Promise<void> {
  const origin = new URL(BASE_URL).origin;
  await context.route(/.*/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const ours = url.origin === origin;
    if (ours && url.pathname === "/api/broadcast" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as Broadcast;
      captured.push({ chainId: body.chainId, txBytes: body.txBytes });
      const txHash = createHash("sha256").update(Buffer.from(body.txBytes, "base64")).digest("hex").toUpperCase();
      return route.fulfill({
        json: { chainId: body.chainId, txHash, code: 0, codespace: "", rawLog: "", success: true, updatedAt: Date.now() },
      });
    }
    // An LCD broadcast (POST …/txs), anything else posted to a broadcast path, and Tendermint RPC
    // broadcast_tx_* in a path or a JSON-RPC body.
    const post = request.method() === "POST";
    if ((post && /broadcast|txs/i.test(url.pathname)) || /broadcast_tx/i.test(url.pathname) || (post && /broadcast_tx/i.test(request.postData() ?? ""))) {
      return route.abort("blockedbyclient");
    }
    if (/\/v1\/connect\//.test(url.pathname)) return route.abort("blockedbyclient");
    if (!ours) return route.continue();
    if (url.pathname === "/api/account") {
      return route.fulfill({
        json: {
          chainId: url.searchParams.get("chainId"),
          address: url.searchParams.get("address"),
          accountNumber: ACCOUNT_NUMBER,
          sequence: SEQUENCE,
          exists: true,
          pubKey: null,
          accountType: "/cosmos.auth.v1beta1.BaseAccount",
          updatedAt: Date.now(),
        },
      });
    }
    if (url.pathname === "/api/tx/simulate") {
      const body = JSON.parse(request.postData() ?? "{}") as { chainId?: string };
      return route.fulfill({ json: { chainId: body.chainId, gasUsed: "120000", gasWanted: null, updatedAt: Date.now() } });
    }
    if (url.pathname.startsWith("/api/tx/")) {
      return route.fulfill({
        json: {
          chainId: url.searchParams.get("chainId"),
          txHash: decodeURIComponent(url.pathname.slice("/api/tx/".length)),
          status: "success",
          height: 1,
          gasUsed: 100_000,
          gasWanted: 150_000,
          updatedAt: Date.now(),
        },
      });
    }
    if (["/api/portfolio", "/api/staking", "/api/governance", "/api/activity"].some((path) => url.pathname.startsWith(path))) {
      return fulfillAsRetail(route, url);
    }
    return route.continue();
  });
}

/* ------------------------------------------------------------------ wallets */

type WalletLabel = "keplr" | "zunia" | "zunia-0.1.4";

interface Wallet {
  label: WalletLabel;
  captured: Broadcast[];
  /** A dashboard page with this wallet connected. */
  open(path: string): Promise<Page>;
  /** How many signing requests the wallet has answered on this page. */
  signed(page: Page): Promise<number>;
  /** Approves a signing request waiting in the wallet; null when none is. */
  approvePending(): Promise<ApprovalItem | null>;
  close(): Promise<void>;
}

const HINT_CHAINS = FOLLOWED.filter((chainId) => chainId in WALLET_CHAINS);

async function keplrWallet(browser: Browser, behaviour: "honest" | "other-bytes" = "honest"): Promise<Wallet> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 1000 } });
  const captured: Broadcast[] = [];
  await installKeplrSigningMockInto(context, {
    mnemonic: MNEMONIC,
    chains: WALLET_CHAINS,
    restore: { chainId: "safrochain-1", chains: HINT_CHAINS },
    name: "E2E Keplr",
    behaviour,
  });
  await failClosed(context, captured);
  return {
    label: "keplr",
    captured,
    open: async (path) => {
      const page = await context.newPage();
      await page.goto(path);
      return page;
    },
    signed: async (page) => (await keplrMockCalls(page)).length,
    approvePending: async () => null,
    close: async () => {
      await context.unrouteAll({ behavior: "ignoreErrors" });
      await context.close();
    },
  };
}

async function zuniaWallet(label: "zunia" | "zunia-0.1.4", dir: string): Promise<Wallet> {
  const session: ExtensionSession = await launchExtension(dir);
  const captured: Broadcast[] = [];
  await importWallet(session, MNEMONIC, [...new Set([...EXTENSION_CHAINS, ...HINT_CHAINS])]);
  await failClosed(session.context, captured);
  let connected = false;
  let approved = 0;
  return {
    label,
    captured,
    signed: async () => approved,
    open: async (path) => {
      const page = await session.context.newPage();
      await page.goto(new URL(path, BASE_URL).href);
      if (!connected) {
        // The first visit connects from the page's own panel; the extension draws its prompt over the page.
        await page.getByRole("main").getByRole("button", { name: /^Zunia extension/ }).click();
        await expect.poll(() => page.frames().some((frame) => frame.url().includes("/connect.html")), { timeout: 30_000 }).toBe(true);
        const prompt = page.frames().find((frame) => frame.url().includes("/connect.html"))!;
        // Its Connect button arms once the frame has been visibly on screen.
        await page.waitForTimeout(1_200);
        await prompt.getByRole("button", { name: /^Connect$/ }).click();
        connected = true;
      }
      return page;
    },
    approvePending: async () => {
      const queue = await session.send<ApprovalItem[]>({ type: "GET_PENDING_APPROVALS" });
      const item = (queue.data ?? []).find((entry) => entry.kind.startsWith("sign")) ?? null;
      if (!item) return null;
      const answer = await session.send({ type: "RESOLVE_APPROVAL", payload: { id: item.id, result: { approved: true } } });
      if (!answer.ok) throw new Error(`Approving failed: ${answer.error ?? "no reason"}`);
      approved += 1;
      return item;
    },
    close: async () => {
      await session.context.unrouteAll({ behavior: "ignoreErrors" });
      await session.close();
    },
  };
}

/* ------------------------------------------------------------------ flows */

type Outcome = "amino" | "direct" | "stopped";

interface Flow {
  name: string;
  /** The page the flow starts on; null skips the flow (nothing live to act on). */
  path: string | (() => Promise<string | null>);
  /** Drives the page up to the click that asks the wallet to sign. */
  drive(page: Page): Promise<void>;
  /** The mode each wallet signs in, or "stopped" when the dashboard must not ask it. */
  expected: Record<WalletLabel, Outcome>;
}

async function waitForAccount(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /^Account:/ })).toBeVisible({ timeout: 45_000 });
}

/** Scopes the page to the Hub, where ATOM is the Send form's default token. */
async function scopeToHub(page: Page): Promise<void> {
  await waitForAccount(page);
  await page.getByRole("group", { name: "Followed chains" }).getByRole("button", { name: "Cosmos Hub" }).click();
}

async function sendOnHub(page: Page, recipient: string, memo: string): Promise<void> {
  await scopeToHub(page);
  await page.getByRole("textbox", { name: "To" }).fill(recipient);
  await page.getByRole("textbox", { name: "Amount" }).fill("0.000001");
  if (memo) await page.getByRole("textbox", { name: "Memo" }).fill(memo);
  await page.getByRole("button", { name: "Review send" }).click();
  await page.getByRole("button", { name: "Confirm in wallet" }).click();
}

/** A Hub validator row's action, from the position list (scoped to the Hub). */
async function validatorAction(page: Page, action: RegExp): Promise<void> {
  await scopeToHub(page);
  await page.getByRole("button", { name: /^Actions for / }).first().click();
  await page.getByRole("menuitem", { name: action }).click();
}

/** Fills a staking dialog's amount, reviews, and confirms with the button that names the action. */
async function confirmStakingDialog(page: Page, confirm: RegExp): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Amount" }).fill("0.000001");
  await dialog.getByRole("button", { name: /^Review$/ }).click();
  await dialog.getByRole("button", { name: confirm }).click();
}

/** A Hub proposal in its voting period, read from the dashboard's own API. */
async function votingProposalPath(): Promise<string | null> {
  try {
    const response = await fetch(new URL("/api/governance?chains=cosmoshub-4&status=voting", BASE_URL), { signal: AbortSignal.timeout(30_000) });
    const body = (await response.json()) as { proposals?: Array<{ id?: unknown; chainId?: unknown }> };
    const proposal = body.proposals?.find((row) => row.chainId === "cosmoshub-4" && typeof row.id === "string");
    return proposal ? `/governance/cosmoshub-4/${String(proposal.id)}` : null;
  } catch {
    return null;
  }
}

/** Picks a token in one of the swap form's pickers, by searching for it. */
async function pickToken(page: Page, side: "token to pay with" | "token to receive", search: string, option: RegExp): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`${side}$`) }).click();
  const picker = page.getByRole("dialog");
  await picker.getByRole("combobox").fill(search);
  await picker.getByRole("option", { name: option }).first().click();
}

/** The swap form across every followed chain: the pair, the amount, review, confirm. Quotes come live from Osmosis. */
async function swap(page: Page, pair: { pay: [string, RegExp]; receive: [string, RegExp]; amount: string }, confirm: RegExp): Promise<void> {
  await waitForAccount(page);
  // The scope persists between pages: widen it so holdings on every chain can be spent.
  await page.getByRole("complementary", { name: "Chain scope" }).getByRole("button", { name: "All chains" }).click();
  await pickToken(page, "token to pay with", ...pair.pay);
  await pickToken(page, "token to receive", ...pair.receive);
  await page.getByRole("textbox", { name: "You pay" }).fill(pair.amount);
  await page.getByRole("button", { name: "Review swap" }).click();
  const review = page.getByRole("dialog");
  // A quote that aged while the review was open is priced again first.
  const refresh = review.getByRole("button", { name: /^Review the new price$/ });
  if (await refresh.isVisible()) await refresh.click();
  await review.getByRole("button", { name: confirm }).click();
}

const FLOWS: Flow[] = [
  {
    name: "Send with memo 'a & b <c>'",
    path: "/send",
    drive: (page) => sendOnHub(page, HUB_RECIPIENT, "a & b <c>"),
    expected: { keplr: "amino", zunia: "direct", "zunia-0.1.4": "direct" },
  },
  {
    name: "Send to a 32-byte address",
    path: "/send",
    drive: (page) => sendOnHub(page, HUB_32_BYTE, ""),
    // A dashboard that reads the capabilities signs this in amino for a legacy build.
    expected: { keplr: "amino", zunia: "direct", "zunia-0.1.4": "amino" },
  },
  {
    name: "IBC transfer to the own Osmosis account",
    path: "/send",
    drive: async (page) => {
      await scopeToHub(page);
      await page.getByRole("button", { name: new RegExp(`^Osmosis ${testAddress("osmosis-1").slice(0, 10)}`) }).click();
      await page.getByRole("textbox", { name: "Amount" }).fill("0.000001");
      await page.getByRole("button", { name: "Review transfer" }).click();
      await page.getByRole("button", { name: "Confirm in wallet" }).click();
    },
    expected: { keplr: "amino", zunia: "direct", "zunia-0.1.4": "direct" },
  },
  {
    name: "Claim staking rewards on the Hub",
    path: "/staking",
    drive: async (page) => {
      await scopeToHub(page);
      await page.getByRole("region", { name: "Staking summary" }).getByRole("button", { name: /^Claim$/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: /^Claim [\d.]+ ATOM$/ }).click();
    },
    expected: { keplr: "amino", zunia: "direct", "zunia-0.1.4": "direct" },
  },
  {
    name: "Stake more with a Hub validator",
    path: "/staking",
    drive: async (page) => {
      await validatorAction(page, /^Stake more/);
      await confirmStakingDialog(page, /^Stake .* ATOM$/);
    },
    expected: { keplr: "amino", zunia: "direct", "zunia-0.1.4": "direct" },
  },
  {
    name: "Move stake to another Hub validator",
    path: "/staking",
    drive: async (page) => {
      await validatorAction(page, /^Move to another validator/);
      await page.getByRole("dialog").getByRole("button", { name: /^To/ }).click();
      await page.getByRole("listbox").getByRole("option").first().click();
      await confirmStakingDialog(page, /^Move .* ATOM$/);
    },
    expected: { keplr: "amino", zunia: "direct", "zunia-0.1.4": "direct" },
  },
  {
    name: "Unstake from a Hub validator",
    path: "/staking",
    drive: async (page) => {
      await validatorAction(page, /^Unstake/);
      await confirmStakingDialog(page, /^Unstake .* ATOM$/);
    },
    expected: { keplr: "amino", zunia: "direct", "zunia-0.1.4": "direct" },
  },
  {
    name: "Vote on a Hub proposal",
    path: votingProposalPath,
    drive: async (page) => {
      await waitForAccount(page);
      const vote = page.getByRole("region", { name: "Your vote" });
      await vote.getByRole("radio", { name: /^Yes/ }).check();
      await vote.getByRole("button", { name: "Review vote" }).click();
      await vote.getByRole("button", { name: /^Sign and vote Yes$/ }).click();
    },
    expected: { keplr: "amino", zunia: "direct", "zunia-0.1.4": "direct" },
  },
  {
    name: "Swap ATOM on the Hub for OSMO (transfer that runs the swap contract)",
    path: "/swap",
    drive: (page) => swap(page, { pay: ["ATOM", /^ATOM Cosmos Hub/], receive: ["OSMO", /^OSMO Osmosis/], amount: "0.001" }, /^Swap ATOM for OSMO$/),
    expected: { keplr: "direct", zunia: "direct", "zunia-0.1.4": "direct" },
  },
  {
    name: "Swap OSMO for ATOM on the Hub (contract call on Osmosis)",
    path: "/swap",
    drive: (page) => swap(page, { pay: ["OSMO", /^OSMO Osmosis/], receive: ["ATOM", /^ATOM Cosmos Hub/], amount: "0.01" }, /^Swap OSMO for ATOM$/),
    // A contract call: a legacy build signs it in amino (no character to escape here).
    expected: { keplr: "direct", zunia: "direct", "zunia-0.1.4": "amino" },
  },
];

interface FlowResult {
  outcome: Outcome;
  verdict: OracleVerdict | null;
  broadcasts: number;
  note: string;
}

/** Runs a flow, approving in the wallet when it asks, until a broadcast is captured or the page gives up. */
async function runFlow(wallet: Wallet, flow: Flow, path: string): Promise<FlowResult> {
  wallet.captured.length = 0;
  const page = await wallet.open(path);
  try {
    const before = await wallet.signed(page);
    await flow.drive(page);
    // A dashboard that stops does so within seconds of the signature, or before asking for one.
    let deadline = Date.now() + 30_000;
    let answered = false;
    while (wallet.captured.length === 0 && Date.now() < deadline) {
      await wallet.approvePending();
      if (!answered && (await wallet.signed(page)) > before) {
        answered = true;
        deadline = Math.min(deadline, Date.now() + 10_000);
      }
      await page.waitForTimeout(300);
    }
    // Anything broadcast after the first is a retry the dashboard must never make.
    await page.waitForTimeout(1_000);
    const [first] = wallet.captured;
    if (!first) {
      // What the page told the user, for the report.
      const text = await page.locator("main").innerText().catch(() => "");
      const said = text.split("\n").find((line) => /nothing was sent|can't sign|cannot sign|unsupported|update zunia|refused/i.test(line));
      return { outcome: "stopped", verdict: null, broadcasts: 0, note: (said ?? "").trim().slice(0, 200) };
    }
    const verdict = verifyTxRaw({ txBytes: first.txBytes, chainId: first.chainId, accountNumber: ACCOUNT_NUMBER });
    return { outcome: verdict.mode, verdict, broadcasts: wallet.captured.length, note: "" };
  } finally {
    await page.close();
  }
}

function walletsUnderTest(): Array<{ label: WalletLabel; dir?: string; flows: string[] }> {
  const all = FLOWS.map((flow) => flow.name);
  const wallets: Array<{ label: WalletLabel; dir?: string; flows: string[] }> = [{ label: "keplr", flows: all }];
  if (process.env.EXT_DIR) wallets.push({ label: "zunia", dir: process.env.EXT_DIR, flows: all });
  if (process.env.EXT_DIR_014) {
    wallets.push({
      label: "zunia-0.1.4",
      dir: process.env.EXT_DIR_014,
      flows: ["Send with memo 'a & b <c>'", "Send to a 32-byte address", "Swap OSMO for ATOM on the Hub (contract call on Osmosis)"],
    });
  }
  return wallets;
}

for (const entry of walletsUnderTest()) {
  test.describe(`${entry.label} signs from the dashboard`, () => {
    // The flows share one wallet and its grant.
    test.describe.configure({ mode: "serial" });
    let wallet: Wallet;

    test.beforeAll(async ({ browser }) => {
      if (entry.dir && !existsSync(`${entry.dir}/manifest.json`)) throw new Error(`No unpacked build at ${entry.dir}`);
      wallet = entry.dir ? await zuniaWallet(entry.label as "zunia" | "zunia-0.1.4", entry.dir) : await keplrWallet(browser);
    });

    test.afterAll(async () => {
      await wallet?.close();
    });

    for (const name of entry.flows) {
      const flow = FLOWS.find((candidate) => candidate.name === name)!;
      test(flow.name, async () => {
        const path = typeof flow.path === "string" ? flow.path : await flow.path();
        test.skip(path === null, "Nothing live to act on (no Hub proposal in its voting period).");
        const result = await runFlow(wallet, flow, path!);
        test.info().annotations.push({ type: "outcome", description: `${result.outcome}${result.note ? `: ${result.note}` : ""}` });
        expect(result.outcome, result.note).toBe(flow.expected[entry.label]);
        if (result.verdict) {
          expect(result.verdict.valid, "the signature the dashboard would broadcast verifies as the chain checks it").toBe(true);
          expect(result.broadcasts).toBe(1);
        }
      });
    }
  });
}

test.describe("a wallet that signs other bytes", () => {
  test("is stopped before anything is broadcast", async ({ browser }) => {
    const wallet = await keplrWallet(browser, "other-bytes");
    try {
      const flow = FLOWS[0]!;
      const result = await runFlow(wallet, flow, flow.path as string);
      test.info().annotations.push({ type: "outcome", description: `${result.outcome}${result.note ? `: ${result.note}` : ""}` });
      expect(result.broadcasts, "a signature over other bytes reached /api/broadcast").toBe(0);
    } finally {
      await wallet.close();
    }
  });
});

test("the Keplr mock answers for the chains the dashboard follows", async ({ browser }) => {
  const wallet = await keplrWallet(browser);
  try {
    const page = await wallet.open("/overview");
    await waitForAccount(page);
    expect(await keplrMockCalls(page)).toEqual([]);
    expect(await page.evaluate((chainId) => (window as unknown as { keplr: { getKey(id: string): Promise<{ bech32Address: string }> } }).keplr.getKey(chainId).then((key) => key.bech32Address), HUB.chainId)).toBe(
      testAddress(HUB.chainId),
    );
  } finally {
    await wallet.close();
  }
});
