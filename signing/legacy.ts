/**
 * Zunia 0.1.4 (and 0.1.3) as rules, for the tiers that need a legacy wallet
 * after the kernel in KERNEL has moved on to 0.1.1. Signing is the same
 * deterministic secp256k1 in every kernel; what differs is what a build agrees
 * to sign and which bytes it signs:
 *
 * - direct: the 0.1.0 kernel (zunia-core 11741e5, crates/cosmos/src/decode.rs)
 *   decodes these types only, and demotes a message to "unknown" when one of
 *   its local addresses is not a 20-byte bech32 address (decode_bech32 accepts
 *   20 bytes only), so a 32-byte contract or recipient is refused;
 * - amino: the bytes are written without escaping, and a type without "Msg"
 *   (Osmosis poolmanager) is refused by the extension's JS summary.
 *
 * Tier 0 checks these rules against the cases' flags on every run, and against
 * the real 0.1.0 kernel whenever KERNEL is still that kernel.
 */

import { fromBech32 } from "@cosmjs/encoding";
import { MsgVote as GovV1MsgVote } from "cosmjs-types/cosmos/gov/v1/tx.js";
import { SignDoc, TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";
import { MsgSend } from "osmojs/cosmos/bank/v1beta1/tx.js";
import { MsgWithdrawDelegatorReward } from "osmojs/cosmos/distribution/v1beta1/tx.js";
import { MsgVote } from "osmojs/cosmos/gov/v1beta1/tx.js";
import { MsgBeginRedelegate, MsgDelegate, MsgUndelegate } from "osmojs/cosmos/staking/v1beta1/tx.js";
import { MsgExecuteContract } from "osmojs/cosmwasm/wasm/v1/tx.js";
import { MsgTransfer } from "osmojs/ibc/applications/transfer/v1/tx.js";
import { MsgSplitRouteSwapExactAmountIn, MsgSwapExactAmountIn } from "osmojs/osmosis/poolmanager/v1beta1/tx.js";

/** typeUrl → the addresses the 0.1.0 decoder requires to be 20-byte bech32. */
const LOCAL_ADDRESSES = new Map<string, (bytes: Uint8Array) => string[]>([
  [MsgSend.typeUrl, (bytes) => ((m) => [m.fromAddress, m.toAddress])(MsgSend.decode(bytes))],
  [MsgDelegate.typeUrl, (bytes) => ((m) => [m.delegatorAddress, m.validatorAddress])(MsgDelegate.decode(bytes))],
  [MsgUndelegate.typeUrl, (bytes) => ((m) => [m.delegatorAddress, m.validatorAddress])(MsgUndelegate.decode(bytes))],
  [
    MsgBeginRedelegate.typeUrl,
    (bytes) => ((m) => [m.delegatorAddress, m.validatorSrcAddress, m.validatorDstAddress])(MsgBeginRedelegate.decode(bytes)),
  ],
  [
    MsgWithdrawDelegatorReward.typeUrl,
    (bytes) => ((m) => [m.delegatorAddress, m.validatorAddress])(MsgWithdrawDelegatorReward.decode(bytes)),
  ],
  [MsgVote.typeUrl, (bytes) => [MsgVote.decode(bytes).voter]],
  [GovV1MsgVote.typeUrl, (bytes) => [GovV1MsgVote.decode(bytes).voter]],
  // The receiver may be an address on another chain, so only the sender is checked.
  [MsgTransfer.typeUrl, (bytes) => [MsgTransfer.decode(bytes).sender]],
  [MsgExecuteContract.typeUrl, (bytes) => ((m) => [m.sender, m.contract])(MsgExecuteContract.decode(bytes))],
  [MsgSwapExactAmountIn.typeUrl, (bytes) => [MsgSwapExactAmountIn.decode(bytes).sender]],
  [MsgSplitRouteSwapExactAmountIn.typeUrl, (bytes) => [MsgSplitRouteSwapExactAmountIn.decode(bytes).sender]],
]);

const POOLMANAGER = "/osmosis.poolmanager.";

function isTwentyByteBech32(address: string): boolean {
  try {
    return fromBech32(address).data.length === 20;
  } catch {
    return false;
  }
}

/**
 * Whether a legacy build refuses these direct sign bytes before any prompt
 * ("Blind signing disabled for unknown messages"). `build` 0.1.3 also refuses
 * Osmosis poolmanager swaps, which its kernel did not decode yet.
 */
export function legacyDirectRefuses(signBytes: Uint8Array, build: "0.1.3" | "0.1.4" = "0.1.4"): boolean {
  const body = TxBody.decode(SignDoc.decode(signBytes).bodyBytes);
  return body.messages.some((any) => {
    if (build === "0.1.3" && any.typeUrl.startsWith(POOLMANAGER)) return true;
    const addresses = LOCAL_ADDRESSES.get(any.typeUrl);
    if (!addresses) return true;
    try {
      return !addresses(any.value).every(isTwentyByteBech32);
    } catch {
      return true;
    }
  });
}

/** Whether a legacy build refuses an amino document: a message type without "Msg". */
export function legacyAminoRefuses(doc: { msgs: Array<{ type: string }> }): boolean {
  return doc.msgs.some((msg) => !msg.type.includes("Msg"));
}
