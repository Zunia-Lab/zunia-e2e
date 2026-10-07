/**
 * The reference cases: every message family the dashboard and the SDK send,
 * built by the reference libraries (osmojs 16.15 encoders and amino
 * converters, cosmjs-types 0.9, CosmJS 0.33.1), never by hand.
 *
 * Keys come from the public BIP39 test phrases only: "abandon … about" for the
 * wallet's first account and "legal winner … yellow" for an account added with
 * its own phrase. Never fund them.
 *
 * Each case says what a correct wallet shows for it (the F1 prompt sentence,
 * the contract body and packet memo the approval JSON carries) and why a
 * legacy build cannot sign it, so expectations.ts can judge every build.
 */

import { Secp256k1HdWallet, makeSignDoc as makeAminoSignDoc } from "@cosmjs/amino";
import { Bip39, EnglishMnemonic, Slip10, Slip10Curve, stringToPath } from "@cosmjs/crypto";
import { fromBase64, fromBech32, toBase64, toBech32, toHex } from "@cosmjs/encoding";
import { DirectSecp256k1HdWallet, makeSignBytes, makeSignDoc } from "@cosmjs/proto-signing";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys.js";
import { MsgVote as GovV1MsgVote } from "cosmjs-types/cosmos/gov/v1/tx.js";
import { AuthInfo, Fee, SignerInfo, TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";
import { Any } from "cosmjs-types/google/protobuf/any.js";
import { GenericAuthorization } from "osmojs/cosmos/authz/v1beta1/authz.js";
import { MsgGrant } from "osmojs/cosmos/authz/v1beta1/tx.js";
import { MsgSend } from "osmojs/cosmos/bank/v1beta1/tx.js";
import { MsgWithdrawDelegatorReward } from "osmojs/cosmos/distribution/v1beta1/tx.js";
import { MsgVote } from "osmojs/cosmos/gov/v1beta1/tx.js";
import { MsgBeginRedelegate, MsgDelegate, MsgUndelegate } from "osmojs/cosmos/staking/v1beta1/tx.js";
import { MsgExecuteContract } from "osmojs/cosmwasm/wasm/v1/tx.js";
import { MsgTransfer } from "osmojs/ibc/applications/transfer/v1/tx.js";
import { AminoConverter as PoolmanagerAmino } from "osmojs/osmosis/poolmanager/v1beta1/tx.amino.js";
import {
  MsgSplitRouteSwapExactAmountIn,
  MsgSplitRouteSwapExactAmountOut,
  MsgSwapExactAmountIn,
  MsgSwapExactAmountOut,
} from "osmojs/osmosis/poolmanager/v1beta1/tx.js";
import { aminoSignBytes, type AminoMsg, type StdSignDoc } from "./amino-json";
import { ADDED_MNEMONIC, MNEMONIC } from "./phrases";

export { ADDED_MNEMONIC, MNEMONIC, fromBase64, fromBech32, toBase64, toBech32, toHex };

/** Osmosis's cross-chain swap contract (XCS), a 32-byte CosmWasm address. */
export const XCS = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";
const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
export const ACCOUNT_NUMBER = "12345";
export const SEQUENCE = "7";
const TIMEOUT = 1791400000000000000n;
const FEE_AMOUNT = "5000";
const GAS = 250000n;

/** The notice a 0.1.5 prompt adds to a transfer that carries a packet memo (E1). */
export const PACKET_MEMO_NOTICE =
  "This transfer carries instructions for the receiving chain (packet memo). Check them under Raw transaction.";

export interface ChainRef {
  chainId: "cosmoshub-4" | "osmosis-1";
  prefix: "cosmos" | "osmo";
  denom: string;
}

export const HUB: ChainRef = { chainId: "cosmoshub-4", prefix: "cosmos", denom: "uatom" };
export const OSMOSIS: ChainRef = { chainId: "osmosis-1", prefix: "osmo", denom: "uosmo" };

/** A key of one of the two test phrases on one chain: m/44'/118'/0'/0/0. */
export interface TestKey {
  address: string;
  pubkey: Uint8Array;
  direct: DirectSecp256k1HdWallet;
  amino: Secp256k1HdWallet;
  /** Signs sha256(bytes) as every Cosmos wallet does (RFC 6979, low S): r‖s, base64. */
  sign(bytes: Uint8Array): string;
}

export type AccountRole = "main" | "added";

export interface CaseMsg {
  typeUrl: string;
  proto: Uint8Array;
  amino: AminoMsg;
}

export interface SigningCase {
  name: string;
  chain: ChainRef;
  memo: string;
  msg: CaseMsg;
  /** The wallet's first account, or the account added with its own phrase. */
  account: AccountRole;
  /** One of the 16 cases of the 2026-10-07 investigation (0.1.3: 23/32, 0.1.4: 25/32). */
  baseline: boolean;
  /**
   * The sentence a correct prompt shows (F1), the same words in both modes.
   * Null in direct mode for a type no build decodes: that row is refused.
   */
  prompt: { direct: string | null; amino: string };
  /**
   * The kernel's own direct summary when the extension rewrites it: a CW721
   * transfer is an `Execute "…"` call to the kernel, and the extension words
   * it as the amino path does (E1). Defaults to `prompt.direct`.
   */
  kernelSummary?: string;
  /** Values the approval's JSON must hold: a contract's body, a packet memo. */
  json: unknown[];
  /** Warnings a 0.1.5 prompt must show. */
  warnings: string[];
  /** What the 0.1.0 kernel (Zunia 0.1.3 and 0.1.4) cannot decode, so refuses in direct mode. */
  legacyDecoder?: "32-byte address" | "exact-out swap" | "unknown type";
  /** An Osmosis poolmanager swap: 0.1.3 does not decode it in direct mode either. */
  poolmanager?: boolean;
}

export interface Reference {
  cases: SigningCase[];
  keys: Record<AccountRole, Record<ChainRef["prefix"], TestKey>>;
}

type Encodable<T, P> = {
  typeUrl: string;
  aminoType: string;
  fromPartial(value: P): T;
  encode(message: T): { finish(): Uint8Array };
  toAmino(message: T): unknown;
};

function msg<T, P>(codec: Encodable<T, P>, value: P): CaseMsg {
  const message = codec.fromPartial(value);
  return {
    typeUrl: codec.typeUrl,
    proto: codec.encode(message).finish(),
    amino: { type: codec.aminoType, value: codec.toAmino(message) as Record<string, unknown> },
  };
}

/** Poolmanager messages carry their amino names in the converter table, not on the codec. */
function poolMsg<T, P>(
  codec: Omit<Encodable<T, P>, "aminoType" | "toAmino">,
  converter: { aminoType: string; toAmino(message: T): unknown },
  value: P,
): CaseMsg {
  const message = codec.fromPartial(value);
  return {
    typeUrl: codec.typeUrl,
    proto: codec.encode(message).finish(),
    amino: { type: converter.aminoType, value: converter.toAmino(message) as Record<string, unknown> },
  };
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
/** A valid address of `bytes` length that nobody holds the key to. */
const placeholder = (prefix: string, seed: string, bytes: 20 | 32): string =>
  toBech32(prefix, sha256(utf8(seed)).slice(0, bytes));

async function testKey(mnemonic: string, prefix: ChainRef["prefix"]): Promise<TestKey> {
  const direct = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix });
  const amino = await Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix });
  const [account] = await direct.getAccounts();
  if (!account) throw new Error("The test wallet has no account");
  const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(mnemonic));
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath("m/44'/118'/0'/0/0"));
  if (toHex(secp256k1.getPublicKey(privkey, true)) !== toHex(account.pubkey)) {
    throw new Error("The derived key is not the wallet's key");
  }
  const sign = (bytes: Uint8Array): string => toBase64(secp256k1.sign(sha256(bytes), privkey, { prehash: false }));
  return { address: account.address, pubkey: account.pubkey, direct, amino, sign };
}

let loaded: Promise<Reference> | null = null;

/** The cases and the keys, built once per process. */
export function loadReference(): Promise<Reference> {
  loaded ??= buildReference();
  return loaded;
}

async function buildReference(): Promise<Reference> {
  const keys: Reference["keys"] = {
    main: { cosmos: await testKey(MNEMONIC, "cosmos"), osmo: await testKey(MNEMONIC, "osmo") },
    added: { cosmos: await testKey(ADDED_MNEMONIC, "cosmos"), osmo: await testKey(ADDED_MNEMONIC, "osmo") },
  };
  const hub = keys.main.cosmos.address;
  const osmo = keys.main.osmo.address;
  const addedOsmo = keys.added.osmo.address;
  const VAL = toBech32("cosmosvaloper", fromBech32(hub).data);
  const VAL2 = placeholder("cosmosvaloper", "val2", 20);
  const CW721 = placeholder("osmo", "cw721 test collection", 32);
  const NFT_RECIPIENT = placeholder("osmo", "nft recipient", 20);

  const hooksMemo = JSON.stringify({
    wasm: {
      contract: XCS,
      msg: {
        osmosis_swap: {
          output_denom: "uosmo",
          slippage: { twap: { window_seconds: 10, slippage_percentage: "5" } },
          receiver: osmo,
          on_failed_delivery: "do_nothing",
        },
      },
    },
  });
  const forwardMemo = JSON.stringify({
    forward: { receiver: placeholder("juno", "pfm receiver", 20), port: "transfer", channel: "channel-42" },
  });
  const xcsBody = {
    osmosis_swap: {
      output_denom: ATOM,
      slippage: { twap: { window_seconds: 10, slippage_percentage: "5" } },
      receiver: hub,
      on_failed_delivery: { local_recovery_addr: osmo },
    },
  };
  const sendNftBody = { send_nft: { contract: XCS, token_id: "rock & roll", msg: toBase64(utf8("{}")) } };
  const transferNftBody = { transfer_nft: { recipient: NFT_RECIPIENT, token_id: "rock & roll" } };
  const recoverBody = { recover: {} };
  const send = (from: string, to: string) =>
    msg(MsgSend, { fromAddress: from, toAddress: to, amount: [{ denom: "uosmo", amount: "1" }] });
  const transfer = (receiver: string, extra: Partial<Parameters<typeof MsgTransfer.fromPartial>[0]> = {}) =>
    msg(MsgTransfer, {
      sourcePort: "transfer",
      sourceChannel: "channel-141",
      token: { denom: "uatom", amount: "1" },
      sender: hub,
      receiver,
      timeoutTimestamp: TIMEOUT,
      ...extra,
    });
  const execute = (contract: string, body: unknown, funds: Array<{ denom: string; amount: string }> = []) =>
    msg(MsgExecuteContract, { sender: osmo, contract, msg: utf8(JSON.stringify(body)), funds });
  const grantAuthorization = GenericAuthorization.fromPartial({ msg: "/cosmos.bank.v1beta1.MsgSend" });

  const base = { account: "main" as const, json: [] as unknown[], warnings: [] as string[], baseline: false };
  const both = (sentence: string) => ({ direct: sentence, amino: sentence });

  const cases: SigningCase[] = [
    // The 16 cases of the 2026-10-07 investigation.
    { ...base, baseline: true, name: "MsgSend memo 'a & b <c>'", chain: OSMOSIS, memo: "a & b <c>", msg: send(osmo, osmo), prompt: both(`Send 1 uosmo to ${osmo}`) },
    { ...base, baseline: true, name: "MsgSend plain memo", chain: OSMOSIS, memo: "rent", msg: send(osmo, osmo), prompt: both(`Send 1 uosmo to ${osmo}`) },
    { ...base, baseline: true, name: "MsgSend to a 32-byte address", chain: OSMOSIS, memo: "", msg: send(osmo, XCS), prompt: both(`Send 1 uosmo to ${XCS}`), legacyDecoder: "32-byte address" },
    { ...base, baseline: true, name: "MsgTransfer timestamp-only", chain: HUB, memo: "", msg: transfer(osmo), prompt: both(`IBC transfer 1 uatom to ${osmo} over channel-141`) },
    { ...base, baseline: true, name: "MsgTransfer + timeout_height", chain: HUB, memo: "", msg: transfer(osmo, { timeoutHeight: { revisionNumber: 1n, revisionHeight: 99999999n } }), prompt: both(`IBC transfer 1 uatom to ${osmo} over channel-141`) },
    { ...base, baseline: true, name: "MsgTransfer ibc-hooks wasm memo", chain: HUB, memo: "", msg: transfer(XCS, { memo: hooksMemo }), prompt: both(`IBC transfer 1 uatom to ${XCS} over channel-141`), json: [hooksMemo], warnings: [PACKET_MEMO_NOTICE] },
    { ...base, baseline: true, name: "MsgDelegate", chain: HUB, memo: "", msg: msg(MsgDelegate, { delegatorAddress: hub, validatorAddress: VAL, amount: { denom: "uatom", amount: "1" } }), prompt: both(`Delegate 1 uatom to ${VAL}`) },
    { ...base, baseline: true, name: "MsgUndelegate", chain: HUB, memo: "", msg: msg(MsgUndelegate, { delegatorAddress: hub, validatorAddress: VAL, amount: { denom: "uatom", amount: "1" } }), prompt: both(`Undelegate 1 uatom from ${VAL}`) },
    { ...base, baseline: true, name: "MsgBeginRedelegate", chain: HUB, memo: "", msg: msg(MsgBeginRedelegate, { delegatorAddress: hub, validatorSrcAddress: VAL, validatorDstAddress: VAL2, amount: { denom: "uatom", amount: "1" } }), prompt: both(`Redelegate 1 uatom from ${VAL} to ${VAL2}`) },
    { ...base, baseline: true, name: "MsgWithdrawDelegatorReward", chain: HUB, memo: "", msg: msg(MsgWithdrawDelegatorReward, { delegatorAddress: hub, validatorAddress: VAL }), prompt: both(`Claim staking rewards from ${VAL}`) },
    { ...base, baseline: true, name: "gov v1beta1 MsgVote", chain: HUB, memo: "", msg: msg(MsgVote, { proposalId: 848n, voter: hub, option: 4 }), prompt: both("Vote No with veto on proposal 848") },
    // gov v1 amino (cosmos-sdk/v1/MsgVote, option as a number, empty metadata omitted) is not in
    // osmojs 16.15 and no chain-verified amino v1 vote exists yet (decision D4 notes a devnet).
    {
      ...base,
      baseline: true,
      name: "gov v1 MsgVote",
      chain: HUB,
      memo: "",
      msg: {
        typeUrl: "/cosmos.gov.v1.MsgVote",
        proto: GovV1MsgVote.encode(GovV1MsgVote.fromPartial({ proposalId: 1000n, voter: hub, option: 1 })).finish(),
        amino: { type: "cosmos-sdk/v1/MsgVote", value: { proposal_id: "1000", voter: hub, option: 1 } },
      },
      prompt: both("Vote Yes on proposal 1000"),
    },
    {
      ...base,
      baseline: true,
      name: "poolmanager exact-in",
      chain: OSMOSIS,
      memo: "",
      msg: poolMsg(MsgSwapExactAmountIn, PoolmanagerAmino["/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn"], {
        sender: osmo,
        routes: [{ poolId: 1n, tokenOutDenom: ATOM }],
        tokenIn: { denom: "uosmo", amount: "1000" },
        tokenOutMinAmount: "1",
      }),
      prompt: both(`Swap 1000 uosmo for at least 1 ${ATOM} through pool 1`),
      poolmanager: true,
    },
    {
      ...base,
      baseline: true,
      name: "poolmanager split-route",
      chain: OSMOSIS,
      memo: "",
      msg: poolMsg(MsgSplitRouteSwapExactAmountIn, PoolmanagerAmino["/osmosis.poolmanager.v1beta1.MsgSplitRouteSwapExactAmountIn"], {
        sender: osmo,
        routes: [
          { pools: [{ poolId: 1n, tokenOutDenom: ATOM }], tokenInAmount: "600" },
          { pools: [{ poolId: 1135n, tokenOutDenom: ATOM }], tokenInAmount: "400" },
        ],
        tokenInDenom: "uosmo",
        tokenOutMinAmount: "1",
      }),
      prompt: both(`Swap 1000 uosmo for at least 1 ${ATOM} through 2 routes (pools 1; 1135)`),
      poolmanager: true,
    },
    { ...base, baseline: true, name: "ExecuteContract XCS (32-byte)", chain: OSMOSIS, memo: "", msg: execute(XCS, xcsBody, [{ denom: "uosmo", amount: "1000" }]), prompt: both(`Execute "osmosis_swap" on ${XCS} sending 1000 uosmo`), json: [xcsBody], legacyDecoder: "32-byte address" },
    { ...base, baseline: true, name: "cw721 send_nft (32-byte, '&' in token id)", chain: OSMOSIS, memo: "", msg: execute(CW721, sendNftBody), prompt: both(`Hand NFT rock & roll from collection ${CW721} to contract ${XCS}`), kernelSummary: `Execute "send_nft" on ${CW721}`, json: [sendNftBody], legacyDecoder: "32-byte address" },

    // Added for 0.1.5.
    {
      ...base,
      name: "poolmanager exact-out",
      chain: OSMOSIS,
      memo: "",
      msg: poolMsg(MsgSwapExactAmountOut, PoolmanagerAmino["/osmosis.poolmanager.v1beta1.MsgSwapExactAmountOut"], {
        sender: osmo,
        routes: [{ poolId: 1n, tokenInDenom: "uosmo" }],
        tokenInMaxAmount: "1000",
        tokenOut: { denom: ATOM, amount: "1" },
      }),
      prompt: both(`Swap at most 1000 uosmo for exactly 1 ${ATOM} through pool 1`),
      legacyDecoder: "exact-out swap",
      poolmanager: true,
    },
    {
      ...base,
      name: "poolmanager split-route exact-out",
      chain: OSMOSIS,
      memo: "",
      msg: poolMsg(MsgSplitRouteSwapExactAmountOut, PoolmanagerAmino["/osmosis.poolmanager.v1beta1.MsgSplitRouteSwapExactAmountOut"], {
        sender: osmo,
        routes: [
          { pools: [{ poolId: 1n, tokenInDenom: "uosmo" }], tokenOutAmount: "6" },
          { pools: [{ poolId: 1135n, tokenInDenom: "uosmo" }], tokenOutAmount: "4" },
        ],
        tokenOutDenom: ATOM,
        tokenInMaxAmount: "1000",
      }),
      prompt: both(`Swap at most 1000 uosmo for exactly 10 ${ATOM} through 2 routes (pools 1; 1135)`),
      legacyDecoder: "exact-out swap",
      poolmanager: true,
    },
    { ...base, name: "MsgSend memo with U+2028", chain: OSMOSIS, memo: "line\u2028break", msg: send(osmo, osmo), prompt: both(`Send 1 uosmo to ${osmo}`) },
    { ...base, name: "MsgTransfer packet-forward memo", chain: HUB, memo: "", msg: transfer(osmo, { memo: forwardMemo }), prompt: both(`IBC transfer 1 uatom to ${osmo} over channel-141`), json: [forwardMemo], warnings: [PACKET_MEMO_NOTICE] },
    {
      ...base,
      name: "authz MsgGrant",
      chain: HUB,
      memo: "",
      msg: msg(MsgGrant, {
        granter: hub,
        grantee: placeholder("cosmos", "grantee", 20),
        grant: { authorization: grantAuthorization, expiration: new Date("2027-01-01T00:00:00Z") },
      }),
      // No build decodes authz: direct is refused and names the type (R1); amino keeps the generic
      // sentence, a documented deferral (decision D2).
      prompt: { direct: null, amino: "Message cosmos-sdk/MsgGrant" },
      legacyDecoder: "unknown type",
    },
    { ...base, name: "ExecuteContract recover (32-byte, no funds)", chain: OSMOSIS, memo: "", msg: execute(XCS, recoverBody), prompt: both(`Execute "recover" on ${XCS}`), json: [recoverBody], legacyDecoder: "32-byte address" },
    { ...base, name: "cw721 transfer_nft (32-byte, '&' in token id)", chain: OSMOSIS, memo: "", msg: execute(CW721, transferNftBody), prompt: both(`Give away NFT rock & roll from collection ${CW721} to ${NFT_RECIPIENT}`), kernelSummary: `Execute "transfer_nft" on ${CW721}`, json: [transferNftBody], legacyDecoder: "32-byte address" },
    { ...base, account: "added", name: "MsgSend from an added account (own phrase)", chain: OSMOSIS, memo: "own phrase", msg: send(addedOsmo, addedOsmo), prompt: both(`Send 1 uosmo to ${addedOsmo}`) },
  ];
  return { cases, keys };
}

export function keyFor(reference: Reference, cs: Pick<SigningCase, "account" | "chain">): TestKey {
  return reference.keys[cs.account][cs.chain.prefix];
}

export interface DirectReference {
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  /** The SignDoc bytes the chain checks. */
  signBytes: Uint8Array;
  /** CosmJS's signature over them (RFC 6979: a wallet signing the same bytes writes the same 64 bytes). */
  referenceSignature: string;
  signer: string;
  pubkey: Uint8Array;
}

/** A single-signer direct document: what a dApp hands `signDirect`, and the bytes the chain checks. */
export function directSignDoc(input: {
  messages: Array<{ typeUrl: string; value: Uint8Array }>;
  memo: string;
  pubkey: Uint8Array;
  chainId: string;
  accountNumber?: string;
  sequence?: string;
  fee?: { denom: string; amount: string };
}): { bodyBytes: Uint8Array; authInfoBytes: Uint8Array; signBytes: Uint8Array } {
  const bodyBytes = TxBody.encode(
    TxBody.fromPartial({ messages: input.messages.map((message) => Any.fromPartial(message)), memo: input.memo }),
  ).finish();
  const authInfoBytes = AuthInfo.encode(
    AuthInfo.fromPartial({
      signerInfos: [
        SignerInfo.fromPartial({
          publicKey: Any.fromPartial({
            typeUrl: "/cosmos.crypto.secp256k1.PubKey",
            value: PubKey.encode(PubKey.fromPartial({ key: input.pubkey })).finish(),
          }),
          modeInfo: { single: { mode: 1 } },
          sequence: BigInt(input.sequence ?? SEQUENCE),
        }),
      ],
      fee: Fee.fromPartial({ amount: [input.fee ?? { denom: "uosmo", amount: FEE_AMOUNT }], gasLimit: GAS }),
    }),
  ).finish();
  const doc = makeSignDoc(bodyBytes, authInfoBytes, input.chainId, Number(input.accountNumber ?? ACCOUNT_NUMBER));
  return { bodyBytes, authInfoBytes, signBytes: makeSignBytes(doc) };
}

/** The direct request for a case: body and auth-info bytes, sign bytes, CosmJS's signature. */
export async function directReference(reference: Reference, cs: SigningCase): Promise<DirectReference> {
  const key = keyFor(reference, cs);
  const { bodyBytes, authInfoBytes, signBytes } = directSignDoc({
    messages: [{ typeUrl: cs.msg.typeUrl, value: cs.msg.proto }],
    memo: cs.memo,
    pubkey: key.pubkey,
    chainId: cs.chain.chainId,
    fee: { denom: cs.chain.denom, amount: FEE_AMOUNT },
  });
  const doc = makeSignDoc(bodyBytes, authInfoBytes, cs.chain.chainId, Number(ACCOUNT_NUMBER));
  const signed = await key.direct.signDirect(key.address, doc);
  return { bodyBytes, authInfoBytes, signBytes, referenceSignature: signed.signature.signature, signer: key.address, pubkey: key.pubkey };
}

export interface AminoReference {
  doc: StdSignDoc;
  /** A1 bytes: what the chain rebuilds. */
  signBytes: Uint8Array;
  /** The signature a correct wallet writes over them. */
  referenceSignature: string;
  /** CosmJS's own signature (`signAmino`), over CosmJS's bytes: A1 without the U+2028 escape. */
  cosmjsSignature: string;
  signer: string;
  pubkey: Uint8Array;
}

/** The amino request for a case: the StdSignDoc, its A1 bytes and the reference signature. */
export async function aminoReference(reference: Reference, cs: SigningCase): Promise<AminoReference> {
  const key = keyFor(reference, cs);
  const doc = makeAminoSignDoc(
    [cs.msg.amino],
    { amount: [{ denom: cs.chain.denom, amount: FEE_AMOUNT }], gas: GAS.toString() },
    cs.chain.chainId,
    cs.memo,
    ACCOUNT_NUMBER,
    SEQUENCE,
  ) as StdSignDoc;
  const signBytes = aminoSignBytes(doc);
  const signed = await key.amino.signAmino(key.address, doc);
  return {
    doc,
    signBytes,
    referenceSignature: key.sign(signBytes),
    cosmjsSignature: signed.signature.signature,
    signer: key.address,
    pubkey: key.pubkey,
  };
}

export interface Judgement {
  /** The wallet answered with the key the request was for. */
  sameKey: boolean;
  /** secp256k1 verifies over sha256(the reference bytes) with the expected key: the chain's check. */
  valid: boolean;
  /** Byte-identical to the reference signature (RFC 6979: same key, same bytes, same 64 bytes). */
  equalsReference: boolean;
}

export function judge(
  signatureB64: string,
  pubkeyB64: string,
  signBytes: Uint8Array,
  referenceSignature: string,
  expectedPubkey: Uint8Array,
): Judgement {
  const pubkey = fromBase64(pubkeyB64);
  let valid = false;
  try {
    valid = secp256k1.verify(fromBase64(signatureB64), sha256(signBytes), expectedPubkey, { prehash: false });
  } catch {
    valid = false;
  }
  return {
    sameKey: toHex(pubkey) === toHex(expectedPubkey),
    valid,
    equalsReference: signatureB64 === referenceSignature,
  };
}
