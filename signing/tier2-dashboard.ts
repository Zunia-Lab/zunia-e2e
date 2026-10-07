/**
 * Tier 2a: the dashboard's real sign flow (DASHBOARD_SRC src/lib/tx/flow.ts
 * `signAndBroadcast`: the sign-mode policy, the plan, the signature, the TxRaw)
 * against four wallets, offline. The TxApi is fake: "broadcast" only captures
 * the bytes, which the oracle then checks the way the chain would. Nothing is
 * sent anywhere.
 *
 * Wallets:
 * - keplr: signs with CosmJS, which signs the bytes Keplr signs;
 * - zunia-0.1.4: the real kernel's signature with 0.1.4's rules (legacy.ts):
 *   direct refused where the 0.1.0 kernel cannot decode, amino over unescaped
 *   bytes, amino types without "Msg" refused; it reports no capabilities;
 * - zunia-0.1.5: the real kernel (KERNEL) and the extension's own serializer
 *   (EXT_SRC), reporting P1 (extensionVersion 0.1.5 and the features);
 * - zunia-mobile: CosmJS-correct, as the phone signs a site's documents.
 *
 * Keplr, Zunia Mobile and Zunia 0.1.4 are compared by diff with the table
 * recorded on the deployed dashboard (baselines/tier2-dashboard-a8cab18.json):
 * the only change allowed is a send to a 32-byte address, which a dashboard
 * that reads the extension's capabilities signs in amino for a legacy build.
 * Zunia 0.1.5 must sign everything in direct mode on such a dashboard. No
 * column may ever broadcast an invalid signature.
 *
 *   pnpm test:signing:dashboard                    DASHBOARD_SRC=… KERNEL=… EXT_SRC=…
 *   SIGNING_RECORD=signing/baselines/x.json …      records the table instead
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { toBase64, toHex } from "@cosmjs/encoding";
import { makeSignBytes } from "@cosmjs/proto-signing";
import { sha256 } from "@noble/hashes/sha2.js";
import { unescapedAminoBytes, type StdSignDoc } from "./amino-json";
import { HUB, MNEMONIC, OSMOSIS, XCS, fromBech32, loadReference, toBech32, type ChainRef } from "./cases";
import { DASHBOARD_SRC, expectedBuild } from "./env";
import { P1_FEATURES, isLegacy, refusalNaming } from "./expectations";
import { kernelIsFixed, kernelSign, loadExtensionSerializer, loadKernel } from "./kernel";
import { legacyAminoRefuses, legacyDirectRefuses } from "./legacy";
import { verifyTxRaw } from "./oracle";
import { Findings, printTable, run } from "./report";

type TxMessage = Record<string, unknown>;
type Builder = (params: Record<string, unknown>) => TxMessage;

interface WalletSignature {
  pub_key: { type: string; value: string };
  signature: string;
}

interface DirectDoc {
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  chainId: string;
  accountNumber: string | bigint;
}

/** The dashboard's `TxSigner` (src/lib/tx/flow.ts). */
interface TxSigner {
  kind: "zunia" | "keplr" | "zunia-mobile";
  capabilities(chainId: string, key: unknown): Record<string, unknown>;
  ensureKey(chainId: string): Promise<{ address: string; pubKey: Uint8Array }>;
  signDirect(chainId: string, signer: string, doc: DirectDoc): Promise<{ signed?: unknown; signature: WalletSignature }>;
  signAmino(chainId: string, signer: string, doc: StdSignDoc): Promise<{ signed?: StdSignDoc; signature: WalletSignature }>;
}

interface Dashboard {
  signAndBroadcast(
    request: { chainId: string; messages: TxMessage[]; memo?: string },
    options: Record<string, unknown>,
  ): Promise<{ signMode: string }>;
  builders: Record<
    "buildSend" | "buildDelegate" | "buildUndelegate" | "buildRedelegate" | "buildWithdrawReward" | "buildVote" | "buildTransfer" | "buildExecuteContract",
    Builder
  >;
  poolSwapTxMessage(typeUrl: string, value: Record<string, unknown>): TxMessage;
  poolSwapTypeUrl: string;
  /** D's `zuniaCapabilities` (src/lib/tx/zunia-capabilities.ts); absent on a8cab18. */
  zuniaCapabilities?: (provider: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The dashboard's modules import each other through its `@/` path alias, which
 * tsx resolves from the tsconfig named in TSX_TSCONFIG_PATH: the process runs
 * itself again with the dashboard's when it was started without it.
 */
function rerunWithDashboardPaths(root: string): boolean {
  const tsconfig = join(root, "tsconfig.json");
  if (process.env.TSX_TSCONFIG_PATH === tsconfig) return false;
  const child = spawnSync(process.execPath, [...process.execArgv, __filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
  });
  process.exitCode = child.status ?? 1;
  return true;
}

async function loadDashboard(root: string): Promise<Dashboard> {
  const load = async (file: string) => (await import(pathToFileURL(join(root, file)).href)) as Record<string, unknown>;
  if (!existsSync(join(root, "src/lib/tx/flow.ts"))) throw new Error(`No dashboard at ${root}. Set DASHBOARD_SRC.`);
  const flow = await load("src/lib/tx/flow.ts");
  const messages = await load("src/lib/tx/messages.ts");
  const osmosis = await load("src/lib/tx/osmosis.ts");
  const capabilities = existsSync(join(root, "src/lib/tx/zunia-capabilities.ts")) ? await load("src/lib/tx/zunia-capabilities.ts") : null;
  return {
    signAndBroadcast: flow.signAndBroadcast as Dashboard["signAndBroadcast"],
    builders: messages as unknown as Dashboard["builders"],
    poolSwapTxMessage: osmosis.poolSwapTxMessage as Dashboard["poolSwapTxMessage"],
    poolSwapTypeUrl: osmosis.POOL_SWAP_TYPE_URL as string,
    ...(capabilities ? { zuniaCapabilities: capabilities.zuniaCapabilities as Dashboard["zuniaCapabilities"] } : {}),
  };
}

const FLOW_CHAINS: Record<string, Record<string, unknown>> = {
  "cosmoshub-4": { chainId: "cosmoshub-4", chainName: "Cosmos Hub", coinType: 118, features: [], feeMinimalDenom: "uatom", feeDenom: "ATOM", feeDecimals: 6, gasPriceStep: { low: 0.005, average: 0.025, high: 0.03 } },
  "osmosis-1": { chainId: "osmosis-1", chainName: "Osmosis", coinType: 118, features: [], feeMinimalDenom: "uosmo", feeDenom: "OSMO", feeDecimals: 6, gasPriceStep: { low: 0.0025, average: 0.025, high: 0.04 } },
};
const CHAIN_REFS: Record<string, ChainRef> = { "cosmoshub-4": HUB, "osmosis-1": OSMOSIS };

/** What a wallet's row came to: the mode it signed in and the oracle's verdict, or where it stopped. */
function outcomeClass(cell: string): string {
  return cell.startsWith("stopped") ? "stopped" : cell;
}

interface Baseline {
  dashboard: string;
  recorded: string;
  wallets: Record<string, Record<string, string>>;
}

run(async () => {
  if (rerunWithDashboardPaths(DASHBOARD_SRC)) return;
  const build = expectedBuild();
  const reference = await loadReference();
  const kernel = await loadKernel();
  const serializer = await loadExtensionSerializer();
  const dashboard = await loadDashboard(DASHBOARD_SRC);
  const findings = new Findings();
  const key = (chainId: string) => reference.keys.main[CHAIN_REFS[chainId]!.prefix];
  const pubKeyOf = (chainId: string) => ({ type: "tendermint/PubKeySecp256k1", value: toBase64(key(chainId).pubkey) });
  const refused = (message: string) => Object.assign(new Error(message), { code: "UNSUPPORTED" });
  const sign = (chainId: string, bytes: Uint8Array) => toBase64(kernelSign(kernel, MNEMONIC, CHAIN_REFS[chainId]!, bytes));
  const directBytes = (doc: DirectDoc) =>
    makeSignBytes({ bodyBytes: doc.bodyBytes, authInfoBytes: doc.authInfoBytes, chainId: doc.chainId, accountNumber: BigInt(doc.accountNumber) });
  const zuniaCaps = (provider: Record<string, unknown>) => (dashboard.zuniaCapabilities ? { zunia: dashboard.zuniaCapabilities(provider) } : {});

  function cosmjsWallet(kind: "keplr" | "zunia-mobile"): TxSigner {
    return {
      kind,
      capabilities: () => ({ amino: true, direct: true }),
      ensureKey: async (chainId) => ({ address: key(chainId).address, pubKey: key(chainId).pubkey }),
      signDirect: async (chainId, signer, doc) => {
        const answer = await key(chainId).direct.signDirect(signer, { ...doc, accountNumber: BigInt(doc.accountNumber) });
        return { signed: { bodyBytes: answer.signed.bodyBytes, authInfoBytes: answer.signed.authInfoBytes }, signature: answer.signature };
      },
      signAmino: async (chainId, signer, doc) => {
        const answer = await key(chainId).amino.signAmino(signer, doc);
        return { signed: answer.signed as StdSignDoc, signature: answer.signature };
      },
    };
  }

  const zunia014: TxSigner = {
    kind: "zunia",
    capabilities: () => ({ amino: true, direct: true, ...zuniaCaps({ version: "0.1.0" }) }),
    ensureKey: async (chainId) => ({ address: key(chainId).address, pubKey: key(chainId).pubkey }),
    signDirect: async (chainId, _signer, doc) => {
      const bytes = directBytes(doc);
      if (legacyDirectRefuses(bytes)) throw refused("Blind signing disabled for unknown messages");
      return { signed: doc, signature: { pub_key: pubKeyOf(chainId), signature: sign(chainId, bytes) } };
    },
    signAmino: async (chainId, _signer, doc) => {
      if (legacyAminoRefuses(doc)) throw refused("Blind signing disabled for unknown messages");
      return { signed: doc, signature: { pub_key: pubKeyOf(chainId), signature: sign(chainId, unescapedAminoBytes(doc)) } };
    },
  };

  const zunia015: TxSigner = {
    kind: "zunia",
    capabilities: () => ({
      amino: true,
      direct: true,
      ...zuniaCaps({ version: "0.1.0", extensionVersion: "0.1.5", isZunia: true, features: [...P1_FEATURES] }),
    }),
    ensureKey: async (chainId) => ({ address: key(chainId).address, pubKey: key(chainId).pubkey }),
    signDirect: async (chainId, _signer, doc) => {
      const bytes = directBytes(doc);
      const decoded = kernel.decodeDirectTx(toHex(bytes));
      if (!decoded.safeWithoutBlindSigning) {
        throw refused(refusalNaming((decoded.messages ?? []).filter((m) => m.unknown).map((m) => m.typeUrl)));
      }
      return { signed: doc, signature: { pub_key: pubKeyOf(chainId), signature: sign(chainId, bytes) } };
    },
    signAmino: async (chainId, _signer, doc) => {
      if (doc.msgs.some((msg) => !msg.type.includes("Msg") && !msg.type.startsWith("osmosis/poolmanager/"))) {
        throw refused("Blind signing disabled for unknown messages");
      }
      return { signed: doc, signature: { pub_key: pubKeyOf(chainId), signature: sign(chainId, serializer.serialize(doc)) } };
    },
  };

  const b = dashboard.builders;
  const hub = key("cosmoshub-4").address;
  const osmo = key("osmosis-1").address;
  const VAL = toBech32("cosmosvaloper", fromBech32(hub).data);
  const VAL2 = toBech32("cosmosvaloper", sha256(new TextEncoder().encode("val2")).slice(0, 20));
  const CW721 = toBech32("osmo", sha256(new TextEncoder().encode("cw721 test collection")));
  const hooks = JSON.stringify({ wasm: { contract: XCS, msg: { osmosis_swap: { output_denom: "uosmo", slippage: { twap: { window_seconds: 10, slippage_percentage: "5" } }, receiver: osmo, on_failed_delivery: "do_nothing" } } } });
  const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
  const coin = (denom: string) => [{ denom, amount: "1" }];
  const CASES: Array<{ name: string; chainId: string; memo?: string; messages: TxMessage[] }> = [
    { name: "send, memo 'a & b <c>'", chainId: "osmosis-1", memo: "a & b <c>", messages: [b.buildSend({ fromAddress: osmo, toAddress: osmo, amount: coin("uosmo") })] },
    { name: "send, plain memo", chainId: "osmosis-1", memo: "rent", messages: [b.buildSend({ fromAddress: osmo, toAddress: osmo, amount: coin("uosmo") })] },
    { name: "send to a 32-byte address", chainId: "osmosis-1", messages: [b.buildSend({ fromAddress: osmo, toAddress: XCS, amount: coin("uosmo") })] },
    { name: "delegate", chainId: "cosmoshub-4", messages: [b.buildDelegate({ delegatorAddress: hub, validatorAddress: VAL, amount: { denom: "uatom", amount: "1" } })] },
    { name: "undelegate", chainId: "cosmoshub-4", messages: [b.buildUndelegate({ delegatorAddress: hub, validatorAddress: VAL, amount: { denom: "uatom", amount: "1" } })] },
    { name: "redelegate", chainId: "cosmoshub-4", messages: [b.buildRedelegate({ delegatorAddress: hub, validatorSrcAddress: VAL, validatorDstAddress: VAL2, amount: { denom: "uatom", amount: "1" } })] },
    { name: "claim", chainId: "cosmoshub-4", messages: [b.buildWithdrawReward({ delegatorAddress: hub, validatorAddress: VAL })] },
    { name: "vote v1beta1 veto", chainId: "cosmoshub-4", messages: [b.buildVote({ proposalId: "848", voter: hub, option: "veto" })] },
    { name: "vote v1 yes", chainId: "cosmoshub-4", messages: [b.buildVote({ proposalId: "1000", voter: hub, option: "yes", govVersion: "v1" })] },
    { name: "IBC transfer (timestamp only)", chainId: "cosmoshub-4", messages: [b.buildTransfer({ sourceChannel: "channel-141", token: { denom: "uatom", amount: "1" }, sender: hub, receiver: osmo })] },
    { name: "IBC transfer, ibc-hooks memo", chainId: "cosmoshub-4", messages: [b.buildTransfer({ sourceChannel: "channel-141", token: { denom: "uatom", amount: "1" }, sender: hub, receiver: XCS, memo: hooks })] },
    { name: "XCS swap from Osmosis (32-byte)", chainId: "osmosis-1", memo: "Swap OSMO to ATOM · by Zunia-wallet", messages: [b.buildExecuteContract({ sender: osmo, contract: XCS, msg: { osmosis_swap: { output_denom: "uatom", slippage: { twap: { window_seconds: 10, slippage_percentage: "5" } }, receiver: hub, on_failed_delivery: { local_recovery_addr: osmo } } }, funds: [{ denom: "uosmo", amount: "1000" }] })] },
    { name: "swap recovery, memo 'a & b'", chainId: "osmosis-1", memo: "a & b", messages: [b.buildExecuteContract({ sender: osmo, contract: XCS, msg: { recover: {} } })] },
    { name: "NFT send_nft, '&' in token id", chainId: "osmosis-1", messages: [b.buildExecuteContract({ sender: osmo, contract: CW721, msg: { send_nft: { contract: XCS, token_id: "rock & roll", msg: "e30=" } } })] },
    { name: "Osmosis pool swap", chainId: "osmosis-1", messages: [dashboard.poolSwapTxMessage(dashboard.poolSwapTypeUrl, { sender: osmo, routes: [{ pool_id: "1", token_out_denom: ATOM }], token_in: { denom: "uosmo", amount: "1000" }, token_out_min_amount: "1" })] },
  ];

  const fixedComponents = kernelIsFixed(kernel) && serializer.escapes;
  const judge015 = !isLegacy(build);
  const wallets: Array<[string, TxSigner]> = [
    ["keplr", cosmjsWallet("keplr")],
    ["zunia-0.1.4", zunia014],
    ...(judge015 ? ([["zunia-0.1.5", zunia015]] as Array<[string, TxSigner]>) : []),
    ["zunia-mobile", cosmjsWallet("zunia-mobile")],
  ];
  if (judge015) {
    findings.require("zunia-0.1.5", fixedComponents, `needs kernel 0.1.1+ and an escaping serializer (kernel ${kernel.kernelVersion()}, EXT_SRC serializer ${serializer.escapes ? "escapes" : "does not escape"})`);
  }

  const table: Record<string, Record<string, string>> = {};
  const rows: Array<Record<string, string>> = [];
  let invalidBroadcasts = 0;
  for (const [label, signer] of wallets) {
    table[label] = {};
    for (const cs of CASES) {
      const captured: string[] = [];
      const api = {
        getAccount: async (chainId: string, address: string) => ({
          chainId,
          address,
          accountNumber: "12345",
          sequence: "7",
          exists: true,
          pubKey: { typeUrl: "/cosmos.crypto.secp256k1.PubKey", key: toBase64(key(chainId).pubkey) },
          accountType: "/cosmos.auth.v1beta1.BaseAccount",
          updatedAt: 0,
        }),
        simulate: async () => ({ gasUsed: "100000" }),
        broadcast: async (chainId: string, txBytes: string) => {
          captured.push(txBytes);
          return { chainId, txHash: "F".repeat(64), code: 0, codespace: "", rawLog: "", success: true, updatedAt: 0 };
        },
        getTx: async () => ({ status: "success", height: 1, gasUsed: 1, gasWanted: 1 }),
      };
      let cell: string;
      try {
        const result = await dashboard.signAndBroadcast(
          { chainId: cs.chainId, messages: cs.messages, ...(cs.memo ? { memo: cs.memo } : {}) },
          { signer, api, chain: FLOW_CHAINS[cs.chainId], sleep: async () => undefined, pollIntervalMs: 0 },
        );
        const [txBytes] = captured;
        if (!txBytes || captured.length !== 1) throw new Error(`broadcast ${captured.length} times`);
        const verdict = verifyTxRaw({ txBytes, chainId: cs.chainId, accountNumber: "12345" });
        if (!verdict.valid) invalidBroadcasts += 1;
        findings.require(`${label}: ${cs.name}`, verdict.valid, "an INVALID signature reached broadcast");
        cell = `${result.signMode} ${verdict.valid ? "VALID" : "INVALID (would broadcast)"}`;
      } catch (error) {
        findings.require(`${label}: ${cs.name}`, captured.length === 0, "stopped after broadcasting");
        const explained = (error as { explained?: { title?: string } }).explained?.title;
        cell = `stopped before broadcast: ${explained ?? (error as Error).message}`;
      }
      table[label]![cs.name] = cell;
      rows.push({ wallet: label, case: cs.name, outcome: cell });
    }
  }
  printTable(rows, 70);

  const record = process.env.SIGNING_RECORD;
  if (record) {
    const recorded: Baseline = { dashboard: DASHBOARD_SRC, recorded: new Date().toISOString(), wallets: table };
    writeFileSync(record, `${JSON.stringify(recorded, null, 2)}\n`);
    console.log(`recorded ${record}`);
  }

  const baseline = JSON.parse(readFileSync(join(__dirname, "baselines/tier2-dashboard-a8cab18.json"), "utf8")) as Baseline;
  const readsCapabilities = dashboard.zuniaCapabilities !== undefined;
  for (const label of ["keplr", "zunia-mobile", "zunia-0.1.4"]) {
    for (const cs of CASES) {
      const before = baseline.wallets[label]?.[cs.name];
      const now = table[label]?.[cs.name];
      if (before === undefined || now === undefined) continue;
      // A dashboard that reads the capabilities signs a legacy build's send to a 32-byte address in amino.
      const expected = label === "zunia-0.1.4" && cs.name === "send to a 32-byte address" && readsCapabilities ? "amino VALID" : outcomeClass(before);
      findings.expect(`${label}: ${cs.name}`, "outcome against the a8cab18 baseline", outcomeClass(now), expected);
    }
  }
  if (judge015 && fixedComponents) {
    for (const cs of CASES) {
      const now = table["zunia-0.1.5"]?.[cs.name] ?? "";
      if (readsCapabilities) findings.expect(`zunia-0.1.5: ${cs.name}`, "outcome", now, "direct VALID");
      else findings.require(`zunia-0.1.5: ${cs.name}`, now.endsWith(" VALID"), `is "${now}" on a dashboard that does not read capabilities`);
    }
  }
  console.log(`dashboard ${DASHBOARD_SRC} (${readsCapabilities ? "reads the extension's capabilities" : "no capabilities: the a8cab18 policy"})`);
  console.log(`kernel ${kernel.kernelVersion()}; extension serializer ${serializer.source} (${serializer.escapes ? "escapes" : "no escaping"})`);
  findings.finish(
    invalidBroadcasts
      ? `${invalidBroadcasts} INVALID signature(s) would have been broadcast`
      : "no invalid signature would be broadcast (offline; nothing was sent)",
  );
});
