/**
 * The chain's signature check, offline. Given the TxRaw a wallet's signature
 * ends up in, rebuild the sign bytes from what is inside it and verify:
 *
 * - direct: the SignDoc over the raw body and auth-info bytes, exactly what
 *   the chain hashes;
 * - amino: the chain never sees the wallet's JSON. It rebuilds the document
 *   from the protobuf messages, so this does too, with the osmojs converters
 *   (checked against real cosmoshub-4 signatures, see anchor.ts) and A1.
 *
 * Tier 2 runs it on the bytes captured at /api/broadcast, which are fulfilled
 * locally and never forwarded.
 */

import { makeSignDoc as makeAminoSignDoc } from "@cosmjs/amino";
import { fromBase64, toHex } from "@cosmjs/encoding";
import { makeSignBytes } from "@cosmjs/proto-signing";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys.js";
import { MsgVote as GovV1MsgVote } from "cosmjs-types/cosmos/gov/v1/tx.js";
import { AuthInfo, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";
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

interface AminoCodec {
  aminoType: string;
  toAmino(bytes: Uint8Array): Record<string, unknown>;
}

function codec<T>(
  decoder: { decode(bytes: Uint8Array): T },
  aminoType: string,
  toAmino: (message: T) => unknown,
): AminoCodec {
  return { aminoType, toAmino: (bytes) => toAmino(decoder.decode(bytes)) as Record<string, unknown> };
}

/** Poolmanager messages carry their amino names in the converter table, not on the codec. */
function poolmanagerCodecs(): Array<[string, AminoCodec]> {
  const exactIn = PoolmanagerAmino["/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn"];
  const splitIn = PoolmanagerAmino["/osmosis.poolmanager.v1beta1.MsgSplitRouteSwapExactAmountIn"];
  const exactOut = PoolmanagerAmino["/osmosis.poolmanager.v1beta1.MsgSwapExactAmountOut"];
  const splitOut = PoolmanagerAmino["/osmosis.poolmanager.v1beta1.MsgSplitRouteSwapExactAmountOut"];
  return [
    [MsgSwapExactAmountIn.typeUrl, codec(MsgSwapExactAmountIn, exactIn.aminoType, (m) => exactIn.toAmino(m))],
    [MsgSplitRouteSwapExactAmountIn.typeUrl, codec(MsgSplitRouteSwapExactAmountIn, splitIn.aminoType, (m) => splitIn.toAmino(m))],
    [MsgSwapExactAmountOut.typeUrl, codec(MsgSwapExactAmountOut, exactOut.aminoType, (m) => exactOut.toAmino(m))],
    [MsgSplitRouteSwapExactAmountOut.typeUrl, codec(MsgSplitRouteSwapExactAmountOut, splitOut.aminoType, (m) => splitOut.toAmino(m))],
  ];
}

/** typeUrl → amino form, from the osmojs telescope converters. */
const CODECS = new Map<string, AminoCodec>([
  [MsgSend.typeUrl, codec(MsgSend, MsgSend.aminoType, (m) => MsgSend.toAmino(m))],
  [MsgDelegate.typeUrl, codec(MsgDelegate, MsgDelegate.aminoType, (m) => MsgDelegate.toAmino(m))],
  [MsgUndelegate.typeUrl, codec(MsgUndelegate, MsgUndelegate.aminoType, (m) => MsgUndelegate.toAmino(m))],
  [MsgBeginRedelegate.typeUrl, codec(MsgBeginRedelegate, MsgBeginRedelegate.aminoType, (m) => MsgBeginRedelegate.toAmino(m))],
  [
    MsgWithdrawDelegatorReward.typeUrl,
    codec(MsgWithdrawDelegatorReward, MsgWithdrawDelegatorReward.aminoType, (m) => MsgWithdrawDelegatorReward.toAmino(m)),
  ],
  [MsgVote.typeUrl, codec(MsgVote, MsgVote.aminoType, (m) => MsgVote.toAmino(m))],
  [MsgTransfer.typeUrl, codec(MsgTransfer, MsgTransfer.aminoType, (m) => MsgTransfer.toAmino(m))],
  [MsgExecuteContract.typeUrl, codec(MsgExecuteContract, MsgExecuteContract.aminoType, (m) => MsgExecuteContract.toAmino(m))],
  [MsgGrant.typeUrl, codec(MsgGrant, MsgGrant.aminoType, (m) => MsgGrant.toAmino(m))],
  ...poolmanagerCodecs(),
  // gov v1 is not in osmojs 16.15. The shape follows x/gov v1's amino registration: option as a
  // number, empty metadata omitted. No chain-verified amino v1 vote backs it yet.
  [
    GovV1MsgVote.typeUrl,
    codec(GovV1MsgVote, "cosmos-sdk/v1/MsgVote", (m) => ({
      proposal_id: m.proposalId.toString(),
      voter: m.voter,
      option: m.option,
      ...(m.metadata ? { metadata: m.metadata } : {}),
    })),
  ],
]);

export type SignMode = "direct" | "amino";

export interface OracleVerdict {
  mode: SignMode;
  valid: boolean;
  signBytesHex: string;
  /** The amino document the chain rebuilds (amino mode only). */
  aminoDoc?: StdSignDoc;
}

const SIGN_MODE_DIRECT = 1;
const SIGN_MODE_LEGACY_AMINO_JSON = 127;

/** The amino messages a chain rebuilds from a body's protobuf messages. */
export function aminoMsgsOf(bodyBytes: Uint8Array): AminoMsg[] {
  return TxBody.decode(bodyBytes).messages.map((any) => {
    const known = CODECS.get(any.typeUrl);
    if (!known) throw new Error(`The oracle has no amino codec for ${any.typeUrl}`);
    return { type: known.aminoType, value: known.toAmino(any.value) };
  });
}

/** Verifies a single-signer TxRaw the way the chain would, for an account number the chain holds. */
export function verifyTxRaw(input: {
  txBytes: Uint8Array | string;
  chainId: string;
  accountNumber: string;
}): OracleVerdict {
  const raw = TxRaw.decode(typeof input.txBytes === "string" ? fromBase64(input.txBytes) : input.txBytes);
  const auth = AuthInfo.decode(raw.authInfoBytes);
  const signer = auth.signerInfos[0];
  if (!signer?.publicKey || auth.signerInfos.length !== 1) throw new Error("The oracle checks single-signer transactions");
  if (signer.publicKey.typeUrl !== "/cosmos.crypto.secp256k1.PubKey") {
    throw new Error(`The oracle checks secp256k1 keys, not ${signer.publicKey.typeUrl}`);
  }
  const mode = signer.modeInfo?.single?.mode;
  const pubkey = PubKey.decode(signer.publicKey.value).key;
  const signature = raw.signatures[0];
  if (!signature) throw new Error("The transaction carries no signature");

  let signBytes: Uint8Array;
  let aminoDoc: StdSignDoc | undefined;
  if (mode === SIGN_MODE_DIRECT) {
    signBytes = makeSignBytes({
      bodyBytes: raw.bodyBytes,
      authInfoBytes: raw.authInfoBytes,
      chainId: input.chainId,
      accountNumber: BigInt(input.accountNumber),
    });
  } else if (mode === SIGN_MODE_LEGACY_AMINO_JSON) {
    const body = TxBody.decode(raw.bodyBytes);
    const fee = auth.fee;
    if (!fee) throw new Error("The transaction carries no fee");
    const timeout = body.timeoutHeight && body.timeoutHeight !== 0n ? body.timeoutHeight : undefined;
    aminoDoc = makeAminoSignDoc(
      aminoMsgsOf(raw.bodyBytes),
      {
        amount: fee.amount.map(({ denom, amount }) => ({ denom, amount })),
        gas: fee.gasLimit.toString(),
        ...(fee.payer ? { payer: fee.payer } : {}),
        ...(fee.granter ? { granter: fee.granter } : {}),
      },
      input.chainId,
      body.memo,
      input.accountNumber,
      signer.sequence.toString(),
      timeout,
    ) as StdSignDoc;
    signBytes = aminoSignBytes(aminoDoc);
  } else {
    throw new Error(`The oracle does not handle sign mode ${String(mode)}`);
  }
  let valid = false;
  try {
    valid = secp256k1.verify(signature, sha256(signBytes), pubkey, { prehash: false });
  } catch {
    valid = false;
  }
  return {
    mode: mode === SIGN_MODE_DIRECT ? "direct" : "amino",
    valid,
    signBytesHex: toHex(signBytes),
    ...(aminoDoc ? { aminoDoc } : {}),
  };
}
