/**
 * Tier 0: the real signing kernel (KERNEL, the wasm the extension links)
 * against the reference, offline, with the public test keys. No browser,
 * nothing broadcast.
 *
 * For every case and sign mode:
 * - decode: would the extension prompt (kernel `decodeDirectTx` reads it) or
 *   refuse; the kernel's sentence (F1) and, from kernel 0.1.1, its payload v2
 *   (K1: type, recipient, contract body, packet memo, fee);
 * - bytes: what the extension signs (direct: the SignDoc; amino: its own
 *   serializeAminoSignDoc from EXT_SRC) against what the chain rebuilds (A1);
 * - sig: the kernel's signature over those bytes verifies over the chain's
 *   bytes, and equals the reference signature byte for byte (RFC 6979).
 *
 * Judged as 0.1.5 (kernel 0.1.1, an escaping serializer) unless SIGNING_EXPECT
 * names a legacy build: SIGNING_EXPECT=0.1.4 checks that today's kernel and
 * source still fail exactly where 0.1.4 is known to.
 *
 *   pnpm exec tsx signing/tier0-kernel.ts      KERNEL=… EXT_SRC=… to point elsewhere
 */

import { toBase64 } from "@cosmjs/encoding";
import { aminoSignBytes } from "./amino-json";
import {
  ACCOUNT_NUMBER,
  ADDED_MNEMONIC,
  MNEMONIC,
  SEQUENCE,
  aminoReference,
  directReference,
  judge,
  loadReference,
  toHex,
  type SigningCase,
} from "./cases";
import { KERNEL, ONLY, expectedBuild } from "./env";
import { expectedDecode, expectedSerializer, isLegacy } from "./expectations";
import {
  kernelIsFixed,
  kernelSign,
  kernelWasmSha256,
  loadExtensionSerializer,
  loadKernel,
  type DecodedDirectTx,
} from "./kernel";
import { legacyDirectRefuses } from "./legacy";
import { Findings, printTable, run } from "./report";

/** K1: what payload v2 must say about the case's one message. */
function payloadProblems(decoded: DecodedDirectTx, cs: SigningCase, refused: boolean): string[] {
  const problems: string[] = [];
  const message = decoded.messages?.[0];
  if (!message || decoded.messages?.length !== 1) return ["payload v2 does not list exactly one message"];
  const value = cs.msg.amino.value;
  const same = (what: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`${what} ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
  };
  same("typeUrl", message.typeUrl, cs.msg.typeUrl);
  same("summary", message.summary, decoded.summaries[0]);
  same("unknown", message.unknown, refused);
  same("accountNumber", decoded.accountNumber, ACCOUNT_NUMBER);
  same("sequence", decoded.sequence, SEQUENCE);
  same("fee", decoded.fee, { amount: [{ denom: cs.chain.denom, amount: "5000" }], gasLimit: "250000" });
  if (cs.msg.typeUrl === "/cosmos.bank.v1beta1.MsgSend") same("recipient", message.recipient, value.to_address);
  if (cs.msg.typeUrl === "/ibc.applications.transfer.v1.MsgTransfer") {
    same("recipient", message.recipient, value.receiver);
    same("detail", message.detail, {
      kind: "ibc-transfer",
      sourceChannel: value.source_channel,
      receiver: value.receiver,
      token: value.token,
      memo: value.memo ?? "",
    });
  }
  if (cs.msg.typeUrl === "/cosmwasm.wasm.v1.MsgExecuteContract") {
    same("detail", message.detail, { kind: "execute-contract", contract: value.contract, msg: value.msg, funds: value.funds ?? [] });
  }
  return problems;
}

run(async () => {
  const reference = await loadReference();
  const kernel = await loadKernel();
  const serializer = await loadExtensionSerializer();
  const fixedKernel = kernelIsFixed(kernel);
  const build = expectedBuild();
  const findings = new Findings();
  findings.expect("kernel", "version is 0.1.1 or later", fixedKernel, !isLegacy(build));
  findings.expect("extension source", "serializer escapes like A1", serializer.escapes, !isLegacy(build));
  const rows: Array<Record<string, string>> = [];
  let k1Rows = 0;

  for (const cs of reference.cases) {
    if (ONLY && !ONLY.test(cs.name)) continue;
    const mnemonic = cs.account === "added" ? ADDED_MNEMONIC : MNEMONIC;

    const d = await directReference(reference, cs);
    const decoded = kernel.decodeDirectTx(toHex(d.signBytes));
    const decode = decoded.safeWithoutBlindSigning ? "prompts" : "refused";
    findings.expect(`${cs.name} (direct)`, "decode", decode, expectedDecode(build, cs));
    if (decode === "prompts") {
      findings.expect(`${cs.name} (direct)`, "kernel sentence", decoded.summaries[0], cs.kernelSummary ?? cs.prompt.direct);
    }
    if (decoded.messages) {
      k1Rows += 1;
      for (const problem of payloadProblems(decoded, cs, decode === "refused")) findings.require(`${cs.name} (direct)`, false, `payload v2 ${problem}`);
    }
    // The legacy rules (legacy.ts) stand in for the 0.1.0 kernel once KERNEL moves on: they
    // must agree with the case's flags, and with the real 0.1.0 decoder while it is the kernel.
    const legacyRefuses = legacyDirectRefuses(d.signBytes);
    findings.expect(`${cs.name} (direct)`, "legacy rules refuse", legacyRefuses, cs.legacyDecoder !== undefined);
    if (!fixedKernel) findings.expect(`${cs.name} (direct)`, "legacy rules agree with the 0.1.0 kernel", legacyRefuses, decode === "refused");
    const directSignature = toBase64(kernelSign(kernel, mnemonic, cs.chain, d.signBytes));
    const directVerdict = judge(directSignature, toBase64(d.pubkey), d.signBytes, d.referenceSignature, d.pubkey);
    findings.require(`${cs.name} (direct)`, directVerdict.valid && directVerdict.equalsReference, "the kernel's signature is not the reference signature");
    rows.push({
      case: cs.name,
      mode: "direct",
      decode: `${decode}: ${decoded.summaries.join(" | ")}`,
      bytes: "SignDoc",
      sig: directVerdict.valid ? "VALID" : "INVALID",
    });

    const a = await aminoReference(reference, cs);
    const written = serializer.serialize(a.doc);
    const bytes = toHex(written) === toHex(aminoSignBytes(a.doc)) ? "== A1" : "!= A1";
    findings.expect(`${cs.name} (amino)`, "extension bytes", bytes, expectedSerializer(build, a.doc));
    const aminoSignature = toBase64(kernelSign(kernel, mnemonic, cs.chain, written));
    const aminoVerdict = judge(aminoSignature, toBase64(a.pubkey), a.signBytes, a.referenceSignature, a.pubkey);
    findings.expect(`${cs.name} (amino)`, "signature verifies", aminoVerdict.valid, bytes === "== A1");
    if (bytes === "== A1") findings.require(`${cs.name} (amino)`, aminoVerdict.equalsReference, "the kernel's signature is not the reference signature");
    rows.push({
      case: cs.name,
      mode: "amino",
      decode: "(the extension summarizes amino in JS)",
      bytes: bytes === "== A1" ? "== A1" : "!= A1 (unescaped & < > U+2028)",
      sig: aminoVerdict.valid ? "VALID" : "INVALID",
    });
  }

  console.log(`judged as Zunia ${build}${process.env.SIGNING_EXPECT ? " (SIGNING_EXPECT)" : ""}`);
  console.log(`kernel ${kernel.kernelVersion()} (wasm sha256 ${kernelWasmSha256() ?? "unknown"}) from ${KERNEL}`);
  console.log(`amino serializer: ${serializer.source} (${serializer.escapes ? "escapes like A1" : "no escaping"})`);
  printTable(rows, 72);
  const refused = rows.filter((row) => row.mode === "direct" && row.decode.startsWith("refused")).length;
  const invalid = rows.filter((row) => row.sig === "INVALID").length;
  findings.finish(
    `${rows.length} rows: ${refused} direct refused by the decoder, ${invalid} invalid signature(s); ` +
      `payload v2 checked on ${k1Rows} row(s)${fixedKernel ? "" : " (kernel before 0.1.1: no payload v2)"}; nothing was broadcast.`,
  );
});
