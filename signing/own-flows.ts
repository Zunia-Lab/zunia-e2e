/**
 * The extension's own wallet transactions (lib/wallet-tx.ts: the popup's Send,
 * Earn and Governance screens), offline: its own amino builders and sign bytes
 * (EXT_SRC lib/amino-tx.ts), the real kernel's signature (KERNEL, public test
 * key) and its own TxRaw assembly, then the chain's check on that TxRaw (the
 * oracle rebuilds the amino document from the protobuf inside it, as the chain
 * does). Nothing is fetched or broadcast.
 *
 * Judged as 0.1.5 (every flow VALID) unless SIGNING_EXPECT names a legacy
 * build: 0.1.4 signs a memo with "&" unescaped, a vote option by its name and
 * a timestamp-only transfer without "timeout_height":{}, all of which the chain
 * refuses.
 *
 *   pnpm exec tsx signing/own-flows.ts      EXT_SRC=… KERNEL=… for another build
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HUB, MNEMONIC, OSMOSIS, fromBech32, loadReference, toBech32, type ChainRef } from "./cases";
import { EXT_SRC, expectedBuild } from "./env";
import { isLegacy, type Outcome } from "./expectations";
import { kernelSign, loadKernel } from "./kernel";
import { verifyTxRaw } from "./oracle";
import { Findings, printTable, run } from "./report";

type AminoMsg = { type: string; value: Record<string, unknown> };

/** The part of the extension's lib/amino-tx.ts these flows call. */
interface AminoTx {
  msgSend(params: { fromAddress: string; toAddress: string; amount: Array<{ denom: string; amount: string }> }): AminoMsg;
  msgDelegate(params: { delegatorAddress: string; validatorAddress: string; amount: { denom: string; amount: string } }): AminoMsg;
  msgVote(params: { proposalId: string; voter: string; option: "yes" | "no" | "veto" | "abstain" }): AminoMsg;
  msgIbcTransfer(params: {
    sourceChannel: string;
    token: { denom: string; amount: string };
    sender: string;
    receiver: string;
    timeoutTimestamp: string;
  }): AminoMsg;
  makeStdSignDoc(params: {
    chainId: string;
    accountNumber: string;
    sequence: string;
    fee: { amount: Array<{ denom: string; amount: string }>; gas: string };
    msgs: AminoMsg[];
    memo: string;
  }): unknown;
  signDocBytes(doc: unknown): Uint8Array;
  assembleAminoTxRaw(params: { signDoc: unknown; pubKey: Uint8Array; signature: Uint8Array }): Uint8Array;
}

interface Flow {
  name: string;
  chain: ChainRef;
  memo: string;
  msgs: AminoMsg[];
  /** Why 0.1.4 gets it wrong, when it does. */
  legacy?: string;
}

run(async () => {
  const build = expectedBuild();
  const file = join(EXT_SRC, "lib/amino-tx.ts");
  if (!existsSync(file)) throw new Error(`No extension source at ${file}. Set EXT_SRC.`);
  const tx = (await import(pathToFileURL(file).href)) as AminoTx;
  const kernel = await loadKernel();
  const reference = await loadReference();
  const hub = reference.keys.main.cosmos.address;
  const osmo = reference.keys.main.osmo.address;
  const VAL = toBech32("cosmosvaloper", fromBech32(hub).data);

  const flows: Flow[] = [
    { name: "Send screen, memo 'rent & food'", chain: OSMOSIS, memo: "rent & food", msgs: [tx.msgSend({ fromAddress: osmo, toAddress: osmo, amount: [{ denom: "uosmo", amount: "1" }] })], legacy: "the memo is signed unescaped" },
    { name: "Send screen, memo 'rent'", chain: OSMOSIS, memo: "rent", msgs: [tx.msgSend({ fromAddress: osmo, toAddress: osmo, amount: [{ denom: "uosmo", amount: "1" }] })] },
    { name: "Earn screen, delegate", chain: HUB, memo: "Stake ATOM · by Zunia-wallet", msgs: [tx.msgDelegate({ delegatorAddress: hub, validatorAddress: VAL, amount: { denom: "uatom", amount: "1" } })] },
    { name: "Governance screen, vote yes", chain: HUB, memo: "Vote · by Zunia-wallet", msgs: [tx.msgVote({ proposalId: "1000", voter: hub, option: "yes" })], legacy: "the option is signed as its name" },
    { name: "msgIbcTransfer, timestamp only", chain: HUB, memo: "", msgs: [tx.msgIbcTransfer({ sourceChannel: "channel-141", token: { denom: "uatom", amount: "1" }, sender: hub, receiver: osmo, timeoutTimestamp: "1791400000000000000" })], legacy: "timeout_height is left out" },
  ];

  const findings = new Findings();
  const rows: Array<Record<string, string>> = [];
  for (const flow of flows) {
    const key = reference.keys.main[flow.chain.prefix];
    const signDoc = tx.makeStdSignDoc({
      chainId: flow.chain.chainId,
      accountNumber: "12345",
      sequence: "7",
      fee: { amount: [{ denom: flow.chain.denom, amount: "5000" }], gas: "200000" },
      msgs: flow.msgs,
      memo: flow.memo,
    });
    const signature = kernelSign(kernel, MNEMONIC, flow.chain, tx.signDocBytes(signDoc));
    let outcome: Outcome;
    let detail = "";
    try {
      const raw = tx.assembleAminoTxRaw({ signDoc, pubKey: key.pubkey, signature });
      outcome = verifyTxRaw({ txBytes: raw, chainId: flow.chain.chainId, accountNumber: "12345" }).valid ? "VALID" : "INVALID";
      if (outcome === "INVALID") detail = "the chain would refuse it: signature verification failed";
    } catch (error) {
      outcome = "REFUSED";
      detail = `cannot assemble: ${(error as Error).message}`;
    }
    const expected: Outcome = isLegacy(build) && flow.legacy ? "INVALID" : "VALID";
    findings.expect(flow.name, "outcome", outcome, expected);
    rows.push({ flow: flow.name, outcome, expected: expected === "VALID" ? "VALID" : `INVALID (${flow.legacy ?? ""})`, detail });
  }
  console.log(`extension source ${EXT_SRC}, kernel ${kernel.kernelVersion()}, judged as Zunia ${build}`);
  printTable(rows, 70);
  findings.finish(`${rows.filter((row) => row.outcome === "VALID").length}/${rows.length} of the extension's own flows valid; nothing was broadcast.`);
});
