/**
 * Anchors the oracle to the chain: real amino-signed cosmoshub-4 transactions
 * (fixtures/chain-verified-amino.json, a copy of zunia-dashboard's
 * src/lib/tx/__tests__/fixtures/chain-verified-amino.json, sha256 956c87af…)
 * are re-encoded to protobuf from their JSON and must verify through
 * verifyTxRaw, exactly as the chain verified them.
 *
 * The same signatures must then fail over the shapes Zunia 0.1.4 writes: a
 * vote option as its enum name, and a timestamp-only transfer without
 * "timeout_height":{}. That is what shows those shapes are wrong.
 *
 *   pnpm exec tsx signing/anchor.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromBase64 } from "@cosmjs/encoding";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys.js";
import { AuthInfo, Fee, SignerInfo, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";
import { Any } from "cosmjs-types/google/protobuf/any.js";
import { MsgVote } from "osmojs/cosmos/gov/v1beta1/tx.js";
import { MsgTransfer } from "osmojs/ibc/applications/transfer/v1/tx.js";
import { aminoSignBytes, type StdSignDoc } from "./amino-json";
import { verifyTxRaw } from "./oracle";
import { Findings, printTable, run } from "./report";

interface ChainCase {
  name: string;
  txHash: string;
  chainId: string;
  accountNumber: string;
  sequence: string;
  fee: { amount: Array<{ denom: string; amount: string }>; gas: string; payer?: string; granter?: string };
  memo: string;
  timeoutHeight: string;
  pubKey: string;
  signature: string;
  message: Record<string, unknown> & { "@type": string };
}

const VOTE_OPTIONS: Record<string, number> = {
  VOTE_OPTION_YES: 1,
  VOTE_OPTION_ABSTAIN: 2,
  VOTE_OPTION_NO: 3,
  VOTE_OPTION_NO_WITH_VETO: 4,
};

interface ChainVote {
  proposal_id: string;
  voter: string;
  option: string;
}

interface ChainTransfer {
  source_port: string;
  source_channel: string;
  token: { denom: string; amount: string };
  sender: string;
  receiver: string;
  timeout_height: { revision_number: string; revision_height: string };
  timeout_timestamp: string;
  memo: string;
}

/** The message as the chain stored it, back to protobuf. */
function messageAny(message: ChainCase["message"]): { typeUrl: string; value: Uint8Array } {
  if (message["@type"] === MsgVote.typeUrl) {
    const m = message as unknown as ChainVote;
    const option = VOTE_OPTIONS[m.option];
    if (option === undefined) throw new Error(`Unknown vote option ${m.option}`);
    return {
      typeUrl: MsgVote.typeUrl,
      value: MsgVote.encode(MsgVote.fromPartial({ proposalId: BigInt(m.proposal_id), voter: m.voter, option })).finish(),
    };
  }
  if (message["@type"] === MsgTransfer.typeUrl) {
    const m = message as unknown as ChainTransfer;
    const height = m.timeout_height;
    return {
      typeUrl: MsgTransfer.typeUrl,
      value: MsgTransfer.encode(
        MsgTransfer.fromPartial({
          sourcePort: m.source_port,
          sourceChannel: m.source_channel,
          token: m.token,
          sender: m.sender,
          receiver: m.receiver,
          timeoutHeight: { revisionNumber: BigInt(height.revision_number), revisionHeight: BigInt(height.revision_height) },
          timeoutTimestamp: BigInt(m.timeout_timestamp),
          memo: m.memo,
        }),
      ).finish(),
    };
  }
  throw new Error(`The anchor does not rebuild ${message["@type"]}`);
}

function txRaw(c: ChainCase): Uint8Array {
  const bodyBytes = TxBody.encode(
    TxBody.fromPartial({ messages: [Any.fromPartial(messageAny(c.message))], memo: c.memo, timeoutHeight: BigInt(c.timeoutHeight) }),
  ).finish();
  const authInfoBytes = AuthInfo.encode(
    AuthInfo.fromPartial({
      signerInfos: [
        SignerInfo.fromPartial({
          publicKey: Any.fromPartial({
            typeUrl: "/cosmos.crypto.secp256k1.PubKey",
            value: PubKey.encode(PubKey.fromPartial({ key: fromBase64(c.pubKey) })).finish(),
          }),
          modeInfo: { single: { mode: 127 } },
          sequence: BigInt(c.sequence),
        }),
      ],
      fee: Fee.fromPartial({ amount: c.fee.amount, gasLimit: BigInt(c.fee.gas), payer: c.fee.payer ?? "", granter: c.fee.granter ?? "" }),
    }),
  ).finish();
  return TxRaw.encode(TxRaw.fromPartial({ bodyBytes, authInfoBytes, signatures: [fromBase64(c.signature)] })).finish();
}

/** Whether the on-chain signature verifies over `doc` written with A1. */
function signatureVerifies(c: ChainCase, doc: StdSignDoc): boolean {
  return secp256k1.verify(fromBase64(c.signature), sha256(aminoSignBytes(doc)), fromBase64(c.pubKey), { prehash: false });
}

/** The document as Zunia 0.1.4 wrote it: the option's name, timeout_height left out when empty. */
function legacyShape(doc: StdSignDoc): { label: string; doc: StdSignDoc } | null {
  const [msg] = doc.msgs;
  if (!msg) return null;
  if (msg.type === "cosmos-sdk/MsgVote") {
    const name = Object.entries(VOTE_OPTIONS).find(([, number]) => number === msg.value.option)?.[0];
    return { label: `option "${name}"`, doc: { ...doc, msgs: [{ type: msg.type, value: { ...msg.value, option: name } }] } };
  }
  // Written as {} (osmojs leaves the zero fields undefined, which JSON drops).
  if (msg.type === "cosmos-sdk/MsgTransfer" && JSON.stringify(msg.value.timeout_height) === "{}") {
    const { timeout_height: _omitted, ...value } = msg.value;
    return { label: "timeout_height omitted", doc: { ...doc, msgs: [{ type: msg.type, value }] } };
  }
  return null;
}

run(async () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/chain-verified-amino.json"), "utf8")) as { cases: ChainCase[] };
  const findings = new Findings();
  const rows: Array<Record<string, string>> = [];
  for (const c of fixture.cases) {
    const verdict = verifyTxRaw({ txBytes: txRaw(c), chainId: c.chainId, accountNumber: c.accountNumber });
    findings.expect(`${c.name} ${c.txHash.slice(0, 12)}`, "on-chain signature verifies through the oracle", verdict.valid, true);
    const legacy = verdict.aminoDoc ? legacyShape(verdict.aminoDoc) : null;
    const legacyVerifies = legacy ? signatureVerifies(c, legacy.doc) : null;
    if (legacy) findings.expect(`${c.name} ${c.txHash.slice(0, 12)}`, `on-chain signature verifies with ${legacy.label}`, legacyVerifies, false);
    rows.push({
      case: c.name,
      tx: c.txHash.slice(0, 12),
      oracle: verdict.valid ? "VERIFIES" : "FAILS",
      "0.1.4 shape": legacy ? `${legacy.label}: ${legacyVerifies ? "VERIFIES" : "fails"}` : "n/a",
    });
  }
  printTable(rows);
  findings.finish(`anchor: ${fixture.cases.length} real cosmoshub-4 amino signatures through the oracle`);
});
