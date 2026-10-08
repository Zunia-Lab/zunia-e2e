import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { expect, test, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys.js";
import { AuthInfo, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";
import { MsgExecuteContract } from "osmojs/cosmwasm/wasm/v1/tx.js";
import { HUB, PACKET_MEMO_NOTICE, XCS, fromBech32, toBech32 } from "../signing/cases";
import { MNEMONIC } from "../signing/phrases";
import {
  CHAINS as EXTENSION_CHAINS,
  importWallet,
  launchExtension,
  type ApprovalItem,
  type ExtensionSession,
} from "../signing/browser";
import { verifyTxRaw, type OracleVerdict } from "../signing/oracle";
import { containsValue } from "../signing/report";
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
 * forms have something to spend; the NFT the test key moves is a token of a
 * collection nobody controls (OSMO_CW721), whose reads are answered here, and
 * the recovery runs after a swap whose tracking is answered as "delivery
 * failed". Keys come from the public "abandon … about" phrase only.
 *
 * On Zunia 0.1.5 every prompt must also be decoded: each message read by the
 * kernel (none unknown) and worded as contract F1 says.
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
/** The same account on Osmosis, the new owner of the NFT the flows move. */
const OSMO_RECIPIENT = toBech32("osmo", fromBech32(HUB_RECIPIENT).data);

/**
 * A CW721 collection on Osmosis with a 32-byte address, as every CosmWasm
 * contract has. Nobody controls it: the flows only sign transfers of its
 * tokens, and its reads (/api/nft/tokens) are answered by the spec.
 */
const OSMO_CW721 = toBech32("osmo", sha256(new TextEncoder().encode("zunia e2e cw721 collection")));
/** Tokens of that collection the test key holds: a plain id, and one whose amino document the chain escapes. */
const NFT_PLAIN = "e2e-1";
const NFT_AMPERSAND = "rock & roll";

function nftPath(tokenId: string): string {
  return `/nfts/osmosis-1/${encodeURIComponent(OSMO_CW721)}/${encodeURIComponent(tokenId)}`;
}

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
 * /api/nft/tokens for OSMO_CW721, in the dashboard's wire shape
 * (zunia-dashboard src/lib/nft/wire.ts): every token asked for, owned by the
 * test key, with nothing read off-chain.
 */
function nftTokensOwnedByTestKey(url: URL): Record<string, unknown> {
  const chainId = url.searchParams.get("chainId") ?? "osmosis-1";
  const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
  return {
    ok: true,
    chainId,
    chainName: "Osmosis",
    contractAddress: OSMO_CW721,
    mediaRequested: url.searchParams.get("media") === "1",
    ipfsGatewayConfigured: false,
    tokens: ids.map((tokenId) => ({
      tokenId,
      collectionAddress: OSMO_CW721,
      chainId,
      name: null,
      description: null,
      owner: testAddress("osmosis-1"),
      tokenUri: null,
      imageUri: null,
      imageUrl: null,
      imageUrlReason: null,
      traits: [],
      metadataSource: null,
      metadataError: null,
      error: null,
    })),
    collection: { contractAddress: OSMO_CW721, name: "Zunia e2e collection", symbol: "ZE2E", description: null, creator: null, tokenCount: 2, error: null },
  };
}

/**
 * Answers the page's swap tracking (POST /api/interchain/track) with the
 * failure only a recovery fixes: the contract swapped, then the delivery to
 * the other chain failed, so the output waits in the contract for the
 * recovery address (zunia-dashboard src/components/swap/SwapTracker.tsx).
 */
async function answerDeliveryFailed(page: Page): Promise<void> {
  await page.route("**/api/interchain/track", (route) => {
    const input = JSON.parse(route.request().postData() ?? "{}") as { sourceTxHash?: string };
    return route.fulfill({
      json: {
        ok: true,
        trace: {
          sourceChainId: "osmosis-1",
          destChainId: "cosmoshub-4",
          sourceTxHash: input.sourceTxHash ?? "",
          hops: [
            {
              index: 0,
              chainId: "osmosis-1",
              channelId: "channel-0",
              port: "transfer",
              counterpartyChainId: "cosmoshub-4",
              kind: "transfer",
              sequence: "1",
              sendTxHash: input.sourceTxHash ?? null,
              receiveTxHash: null,
              status: "failed",
              error: "The delivery to Cosmos Hub failed.",
              stalled: false,
              fundsRefunded: false,
            },
          ],
          status: "failed",
          failure: "swap-delivery-failed",
          stalled: false,
          currentHopIndex: 0,
          elapsedSeconds: 30,
          estimatedDurationSeconds: 60,
          updatedAt: Date.now(),
          notes: [],
          recovery: {
            chainId: "osmosis-1",
            contractAddress: XCS,
            recoveryAddress: testAddress("osmosis-1"),
            ready: true,
            executeMsgJson: '{"recover":{}}',
          },
        },
      },
    });
  });
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
    if (url.pathname === "/api/nft/tokens" && url.searchParams.get("contract") === OSMO_CW721) {
      return route.fulfill({ json: nftTokensOwnedByTestKey(url) });
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
  /** Every prompt the wallet approved, in order, as its queue showed it (none for the Keplr mock, which has no prompt). */
  approvals: ApprovalItem[];
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
    approvals: [],
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
  const approvals: ApprovalItem[] = [];
  return {
    label,
    captured,
    approvals,
    signed: async () => approvals.length,
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
      approvals.push(item);
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
  /** Drives the page up to the click that asks the wallet to sign the transaction the flow judges. */
  drive(page: Page, wallet: Wallet): Promise<void>;
  /** The mode each wallet signs in, or "stopped" when the dashboard must not ask it. */
  expected: Record<WalletLabel, Outcome>;
  /** Zunia 0.1.5: the F1 sentence one message of the judged prompt reads. */
  prompt: RegExp;
  /** Zunia 0.1.5: a notice the judged prompt must carry. */
  notice?: string;
  /** The memo the judged transaction must carry, byte for byte, when the flow sets one. */
  memo?: string;
  /** A node the judged transaction's contract call must carry, deep-equal (its execute message, or a value in it). */
  contractCall?: unknown;
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

/** Moves the NFT the page shows to OSMO_RECIPIENT, on Osmosis: a CW721 `transfer_nft`. */
async function moveNft(page: Page): Promise<void> {
  await waitForAccount(page);
  await page.getByRole("button", { name: "Move this NFT" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("textbox", { name: "New owner" }).fill(OSMO_RECIPIENT);
  await sheet.getByRole("button", { name: "Review transfer" }).click();
  await sheet.getByRole("button", { name: "Sign in wallet" }).click();
}

/**
 * For a flow that signs once before the transaction it judges (the swap a
 * recovery follows): approves until that first transaction is broadcast,
 * checks it as the chain would, and clears the capture for the next one.
 */
async function settleFirst(wallet: Wallet, page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (wallet.captured.length === 0 && Date.now() < deadline) {
    await wallet.approvePending();
    await page.waitForTimeout(300);
  }
  const [first, ...retries] = wallet.captured;
  expect(first, "the first transaction reached /api/broadcast").toBeDefined();
  expect(retries, "the first transaction was broadcast once").toEqual([]);
  expect(verifyTxRaw({ txBytes: first!.txBytes, chainId: first!.chainId, accountNumber: ACCOUNT_NUMBER }).valid, "the first transaction's signature verifies").toBe(true);
  wallet.captured.length = 0;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const VALOPER = "cosmosvaloper1[02-9ac-hj-np-z]+";
const ATOM_ON_OSMOSIS = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";

const FLOWS: Flow[] = [
  {
    name: "Send with memo 'a & b <c>'",
    path: "/send",
    drive: (page) => sendOnHub(page, HUB_RECIPIENT, "a & b <c>"),
    expected: { keplr: "amino", zunia: "direct", "zunia-0.1.4": "direct" },
    memo: "a & b <c>",
    prompt: new RegExp(`^Send 1 uatom to ${HUB_RECIPIENT}$`),
  },
  {
    name: "Send to a 32-byte address",
    path: "/send",
    drive: (page) => sendOnHub(page, HUB_32_BYTE, ""),
    // A dashboard that reads the capabilities signs this in amino for a legacy build.
    expected: { keplr: "amino", zunia: "direct", "zunia-0.1.4": "amino" },
    prompt: new RegExp(`^Send 1 uatom to ${HUB_32_BYTE}$`),
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
    prompt: new RegExp(`^IBC transfer 1 uatom to ${testAddress("osmosis-1")} over channel-\\d+$`),
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
    prompt: new RegExp(`^Claim staking rewards from ${VALOPER}$`),
  },
  {
    name: "Stake more with a Hub validator",
    path: "/staking",
    drive: async (page) => {
      await validatorAction(page, /^Stake more/);
      await confirmStakingDialog(page, /^Stake .* ATOM$/);
    },
    expected: { keplr: "amino", zunia: "direct", "zunia-0.1.4": "direct" },
    prompt: new RegExp(`^Delegate 1 uatom to ${VALOPER}$`),
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
    prompt: new RegExp(`^Redelegate 1 uatom from ${VALOPER} to ${VALOPER}$`),
  },
  {
    name: "Unstake from a Hub validator",
    path: "/staking",
    drive: async (page) => {
      await validatorAction(page, /^Unstake/);
      await confirmStakingDialog(page, /^Unstake .* ATOM$/);
    },
    expected: { keplr: "amino", zunia: "direct", "zunia-0.1.4": "direct" },
    prompt: new RegExp(`^Undelegate 1 uatom from ${VALOPER}$`),
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
    prompt: /^Vote Yes on proposal \d+$/,
  },
  {
    name: "Swap ATOM on the Hub for OSMO (transfer that runs the swap contract)",
    path: "/swap",
    drive: (page) => swap(page, { pay: ["ATOM", /^ATOM Cosmos Hub/], receive: ["OSMO", /^OSMO Osmosis/], amount: "0.001" }, /^Swap ATOM for OSMO$/),
    expected: { keplr: "direct", zunia: "direct", "zunia-0.1.4": "direct" },
    // The ibc-hooks memo runs the swap contract: the prompt says the transfer carries instructions.
    prompt: new RegExp(`^IBC transfer \\d+ uatom to ${XCS} over channel-\\d+$`),
    notice: PACKET_MEMO_NOTICE,
  },
  {
    name: "Swap OSMO for ATOM on the Hub (contract call on Osmosis)",
    path: "/swap",
    drive: (page) => swap(page, { pay: ["OSMO", /^OSMO Osmosis/], receive: ["ATOM", /^ATOM Cosmos Hub/], amount: "0.01" }, /^Swap OSMO for ATOM$/),
    // A contract call: a legacy build signs it in amino (no character to escape here).
    expected: { keplr: "direct", zunia: "direct", "zunia-0.1.4": "amino" },
    prompt: new RegExp(`^Execute "osmosis_swap" on ${XCS} sending \\d+ uosmo$`),
    // The contract delivers the output to the test key on the Hub.
    contractCall: testAddress("cosmoshub-4"),
  },
  {
    name: "Swap OSMO for ATOM in an Osmosis pool",
    path: "/swap",
    // The picker names a token by its home chain, then where it is held: here ATOM held on Osmosis.
    drive: (page) => swap(page, { pay: ["OSMO", /^OSMO Osmosis/], receive: ["ATOM", /^ATOM Cosmos Hub ATOM · on Osmosis/], amount: "0.01" }, /^Swap OSMO for ATOM$/),
    // A poolmanager swap: every build decodes it in direct mode (0.1.4 on).
    expected: { keplr: "direct", zunia: "direct", "zunia-0.1.4": "direct" },
    prompt: new RegExp(`^Swap \\d+ uosmo for at least \\d+ ${escapeRegExp(ATOM_ON_OSMOSIS)} through .+$`),
  },
  {
    name: "Recover a swap whose delivery failed",
    path: "/swap",
    drive: async (page, wallet) => {
      await answerDeliveryFailed(page);
      await swap(page, { pay: ["OSMO", /^OSMO Osmosis/], receive: ["ATOM", /^ATOM Cosmos Hub/], amount: "0.01" }, /^Swap OSMO for ATOM$/);
      await settleFirst(wallet, page);
      await page.getByRole("dialog").getByRole("button", { name: "Recover on Osmosis" }).click();
    },
    // The recovery is a contract call on Osmosis, from the recovery address.
    expected: { keplr: "direct", zunia: "direct", "zunia-0.1.4": "amino" },
    memo: "Recover swap - by Zunia-dashboard",
    contractCall: { recover: {} },
    prompt: new RegExp(`^Execute "recover" on ${XCS}$`),
  },
  {
    name: "Move an NFT on Osmosis",
    path: nftPath(NFT_PLAIN),
    drive: moveNft,
    // A contract call: a legacy build signs it in amino (no character to escape here).
    expected: { keplr: "direct", zunia: "direct", "zunia-0.1.4": "amino" },
    contractCall: { transfer_nft: { recipient: OSMO_RECIPIENT, token_id: NFT_PLAIN } },
    prompt: new RegExp(`^Give away NFT ${escapeRegExp(NFT_PLAIN)} from collection ${OSMO_CW721} to ${OSMO_RECIPIENT}$`),
  },
  {
    name: "Move an NFT whose id holds '&'",
    path: nftPath(NFT_AMPERSAND),
    drive: moveNft,
    // A legacy build can sign this contract call neither way (amino unescaped, direct refused): nothing may be broadcast.
    expected: { keplr: "direct", zunia: "direct", "zunia-0.1.4": "stopped" },
    contractCall: { transfer_nft: { recipient: OSMO_RECIPIENT, token_id: NFT_AMPERSAND } },
    prompt: new RegExp(`^Give away NFT ${escapeRegExp(NFT_AMPERSAND)} from collection ${OSMO_CW721} to ${OSMO_RECIPIENT}$`),
  },
];

/** What a captured transaction carries: its messages' types, its memo, its contract calls and the account of the key that signed it. */
interface TxContents {
  chainId: string;
  typeUrls: string[];
  memo: string;
  contractCalls: unknown[];
  signer: string;
}

function contentsOf(broadcast: Broadcast): TxContents {
  const raw = TxRaw.decode(Buffer.from(broadcast.txBytes, "base64"));
  const key = AuthInfo.decode(raw.authInfoBytes).signerInfos[0]?.publicKey;
  const pubkey = key ? PubKey.decode(key.value).key : new Uint8Array();
  const body = TxBody.decode(raw.bodyBytes);
  return {
    chainId: broadcast.chainId,
    typeUrls: body.messages.map((message) => message.typeUrl),
    memo: body.memo,
    contractCalls: body.messages
      .filter((message) => message.typeUrl === MsgExecuteContract.typeUrl)
      .map((message) => JSON.parse(new TextDecoder().decode(MsgExecuteContract.decode(message.value).msg)) as unknown),
    signer: toBech32(WALLET_CHAINS[broadcast.chainId]?.prefix ?? "unknown", ripemd160(sha256(pubkey))),
  };
}

interface FlowResult {
  outcome: Outcome;
  verdict: OracleVerdict | null;
  /** The judged transaction, null when nothing was broadcast. */
  contents: TxContents | null;
  broadcasts: number;
  note: string;
  /** The prompts the wallet approved during the flow, the judged one last. */
  approvals: ApprovalItem[];
}

/** Runs a flow, approving in the wallet when it asks, until a broadcast is captured or the page gives up. */
async function runFlow(wallet: Wallet, flow: Flow, path: string): Promise<FlowResult> {
  wallet.captured.length = 0;
  const approvedBefore = wallet.approvals.length;
  const page = await wallet.open(path);
  try {
    const before = await wallet.signed(page);
    await flow.drive(page, wallet);
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
    const approvals = wallet.approvals.slice(approvedBefore);
    if (!first) {
      // What the page told the user, for the report: sheets and toasts sit outside main.
      const text = await page.locator("body").innerText().catch(() => "");
      const said = text.split("\n").find((line) => /nothing was sent|can't sign|cannot sign|unsupported|update zunia|refused/i.test(line));
      return { outcome: "stopped", verdict: null, contents: null, broadcasts: 0, note: (said ?? "").trim().slice(0, 200), approvals };
    }
    const verdict = verifyTxRaw({ txBytes: first.txBytes, chainId: first.chainId, accountNumber: ACCOUNT_NUMBER });
    return { outcome: verdict.mode, verdict, contents: contentsOf(first), broadcasts: wallet.captured.length, note: "", approvals };
  } finally {
    await page.close();
  }
}

/**
 * Zunia 0.1.5: every message of every prompt the flow approved was read by the
 * kernel (none unknown, each with a sentence rather than a type name), and the
 * judged prompt reads the flow's F1 sentence and carries its notice.
 */
function expectDecodedPrompts(approvals: ApprovalItem[], flow: Flow): void {
  expect(approvals.length, "the wallet prompted for the transaction").toBeGreaterThan(0);
  for (const approval of approvals) {
    const messages = approval.detail?.summary?.messages ?? [];
    expect(messages.length, `the ${approval.kind} prompt lists its messages`).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message.unknown ?? false, `${message.type} is decoded, not unknown`).toBe(false);
      expect(message.summary, `${message.type} reads as a sentence`).toMatch(/^(?!Message |\/)\S/);
    }
  }
  const judged = approvals[approvals.length - 1]!;
  const summaries = (judged.detail?.summary?.messages ?? []).map((message) => message.summary);
  expect(summaries.some((summary) => flow.prompt.test(summary)), `the prompt reads ${flow.prompt}; it reads ${JSON.stringify(summaries)}`).toBe(true);
  if (flow.notice) {
    expect([...(judged.warnings ?? []), ...(judged.detail?.summary?.warnings ?? [])], "the prompt carries its notice").toContain(flow.notice);
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
      flows: [
        "Send with memo 'a & b <c>'",
        "Send to a 32-byte address",
        "Swap OSMO for ATOM on the Hub (contract call on Osmosis)",
        "Move an NFT on Osmosis",
        "Move an NFT whose id holds '&'",
      ],
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
        if (result.contents) test.info().annotations.push({ type: "transaction", description: JSON.stringify(result.contents) });
        for (const approval of result.approvals) {
          test.info().annotations.push({ type: "prompt", description: JSON.stringify({ kind: approval.kind, messages: approval.detail?.summary?.messages?.map((m) => [m.type, m.summary, m.unknown ?? false]), warnings: approval.warnings }) });
        }
        expect(result.outcome, result.note).toBe(flow.expected[entry.label]);
        if (result.verdict) {
          expect(result.verdict.valid, "the signature the dashboard would broadcast verifies as the chain checks it").toBe(true);
          expect(result.broadcasts).toBe(1);
        }
        if (result.contents) {
          // The chain charges the account of the key in the transaction: it must be the test key's.
          expect(result.contents.signer, "the transaction carries the test key").toBe(testAddress(result.contents.chainId));
          if (flow.memo !== undefined) expect(result.contents.memo, "the memo reaches the signed bytes as typed").toBe(flow.memo);
          if (flow.contractCall !== undefined) {
            expect(containsValue(result.contents.contractCalls, flow.contractCall), `the contract call carries ${JSON.stringify(flow.contractCall)}`).toBe(true);
          }
        }
        if (entry.label === "zunia") expectDecodedPrompts(result.approvals, flow);
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
