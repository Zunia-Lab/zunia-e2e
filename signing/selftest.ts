/**
 * Self-test of the oracle and the reference, offline, before anything is
 * judged with them:
 *
 * - every case's CosmJS-signed transaction verifies, in both modes, and a
 *   one-bit flip does not;
 * - a signature over the bytes Zunia 0.1.4 writes (no escaping) verifies
 *   exactly when the document has nothing to escape;
 * - CosmJS's amino signature verifies exactly when CosmJS writes A1 bytes
 *   (every document without U+2028 or U+2029);
 * - the amino form the oracle rebuilds from protobuf is the case's own, and
 *   @cosmjs/stargate's converters write the same JSON as osmojs's;
 * - A1 escapes strings exactly as Go's json.Marshal does (needs a Go toolchain).
 *
 *   pnpm exec tsx signing/selftest.ts
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { serializeSignDoc } from "@cosmjs/amino";
import { AminoTypes, createDefaultAminoConverters, defaultRegistryTypes } from "@cosmjs/stargate";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys.js";
import { AuthInfo, Fee, SignerInfo, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";
import { Any } from "cosmjs-types/google/protobuf/any.js";
import { escapeLikeGo, needsEscaping, sortKeys, unescapedAminoBytes } from "./amino-json";
import {
  ACCOUNT_NUMBER,
  SEQUENCE,
  aminoReference,
  directReference,
  fromBase64,
  keyFor,
  loadReference,
  toHex,
  type SigningCase,
} from "./cases";
import { aminoMsgsOf, verifyTxRaw } from "./oracle";
import { Findings, run } from "./report";

function aminoTxRaw(cs: SigningCase, pubkey: Uint8Array, signature: string): Uint8Array {
  const bodyBytes = TxBody.encode(
    TxBody.fromPartial({ messages: [Any.fromPartial({ typeUrl: cs.msg.typeUrl, value: cs.msg.proto })], memo: cs.memo }),
  ).finish();
  const authInfoBytes = AuthInfo.encode(
    AuthInfo.fromPartial({
      signerInfos: [
        SignerInfo.fromPartial({
          publicKey: Any.fromPartial({
            typeUrl: "/cosmos.crypto.secp256k1.PubKey",
            value: PubKey.encode(PubKey.fromPartial({ key: pubkey })).finish(),
          }),
          modeInfo: { single: { mode: 127 } },
          sequence: BigInt(SEQUENCE),
        }),
      ],
      fee: Fee.fromPartial({ amount: [{ denom: cs.chain.denom, amount: "5000" }], gasLimit: 250000n }),
    }),
  ).finish();
  return TxRaw.encode(TxRaw.fromPartial({ bodyBytes, authInfoBytes, signatures: [fromBase64(signature)] })).finish();
}

/** Strings whose escaping differs between JSON.stringify, CosmJS and Go, and some that do not. */
const ESCAPE_PROBES = ["a & b <c>", "line\u2028sep\u2029para", "bs\bff\fnl\nct\u0001", "café ☕ 😀", 'quote" back\\ slash/', ""];

function compareWithGo(findings: Findings): string {
  const go = spawnSync("go", ["run", join(__dirname, "go/escape.go")], {
    input: JSON.stringify(ESCAPE_PROBES),
    encoding: "utf8",
    timeout: 120_000,
  });
  if (go.error || go.status !== 0) return "skipped (no Go toolchain answered)";
  const lines = go.stdout.trimEnd().split("\n");
  ESCAPE_PROBES.forEach((probe, index) => {
    findings.expect(`A1 vs Go json.Marshal ${JSON.stringify(probe)}`, "A1", escapeLikeGo(JSON.stringify(probe)), lines[index]);
  });
  return `A1 equals Go's json.Marshal on ${ESCAPE_PROBES.length} strings`;
}

run(async () => {
  const reference = await loadReference();
  const findings = new Findings();
  const stargate = new AminoTypes(createDefaultAminoConverters());
  let crossChecked = 0;

  for (const cs of reference.cases) {
    const key = keyFor(reference, cs);
    const d = await directReference(reference, cs);
    findings.expect(cs.name, "CosmJS direct signature == the reference key's", d.referenceSignature, key.sign(d.signBytes));
    const signedDirect = TxRaw.encode(
      TxRaw.fromPartial({ bodyBytes: d.bodyBytes, authInfoBytes: d.authInfoBytes, signatures: [fromBase64(d.referenceSignature)] }),
    ).finish();
    findings.expect(cs.name, "direct (CosmJS) verifies", verifyTxRaw({ txBytes: signedDirect, chainId: cs.chain.chainId, accountNumber: ACCOUNT_NUMBER }).valid, true);
    const flipped = fromBase64(d.referenceSignature);
    flipped[10] = (flipped[10] ?? 0) ^ 1;
    const flippedTx = TxRaw.encode(
      TxRaw.fromPartial({ bodyBytes: d.bodyBytes, authInfoBytes: d.authInfoBytes, signatures: [flipped] }),
    ).finish();
    findings.expect(cs.name, "direct with one bit flipped verifies", verifyTxRaw({ txBytes: flippedTx, chainId: cs.chain.chainId, accountNumber: ACCOUNT_NUMBER }).valid, false);

    const a = await aminoReference(reference, cs);
    findings.expect(cs.name, "oracle's amino form from protobuf", aminoMsgsOf(TxBody.encode(TxBody.fromPartial({ messages: [Any.fromPartial({ typeUrl: cs.msg.typeUrl, value: cs.msg.proto })] })).finish()), [cs.msg.amino]);
    const verifies = (signature: string): boolean =>
      verifyTxRaw({ txBytes: aminoTxRaw(cs, a.pubkey, signature), chainId: cs.chain.chainId, accountNumber: ACCOUNT_NUMBER }).valid;
    findings.expect(cs.name, "amino (reference signature over A1) verifies", verifies(a.referenceSignature), true);
    const cosmjsWritesA1 = toHex(serializeSignDoc(a.doc)) === toHex(a.signBytes);
    findings.expect(cs.name, "amino (CosmJS signAmino) verifies", verifies(a.cosmjsSignature), cosmjsWritesA1);
    if (cosmjsWritesA1) findings.expect(cs.name, "CosmJS amino signature == the reference", a.cosmjsSignature, a.referenceSignature);
    findings.expect(cs.name, "amino over 0.1.4's unescaped bytes verifies", verifies(key.sign(unescapedAminoBytes(a.doc))), !needsEscaping(a.doc));

    // A second reference converter for the standard messages: @cosmjs/stargate (what Keplr's
    // libraries and most dApps use) must write the same amino JSON as osmojs.
    try {
      const fromStargate = stargate.toAmino({ typeUrl: cs.msg.typeUrl, value: decodeForStargate(cs) });
      findings.expect(cs.name, "@cosmjs/stargate amino == osmojs amino", sortKeys(fromStargate), sortKeys(cs.msg.amino));
      crossChecked += 1;
    } catch {
      // Not a stargate default type (contracts, poolmanager, gov v1, authz).
    }
  }

  const go = compareWithGo(findings);
  findings.finish(
    `oracle self-test: ${reference.cases.length} cases × (direct, bit flip, amino, CosmJS amino, unescaped amino); ` +
      `${crossChecked} cross-checked against @cosmjs/stargate; ${go}`,
  );
});

const STARGATE_TYPES = new Map(defaultRegistryTypes);

/** The protobuf message as @cosmjs/stargate's converters take it (decoded, camelCase). */
function decodeForStargate(cs: SigningCase): unknown {
  const type = STARGATE_TYPES.get(cs.msg.typeUrl);
  if (!type) throw new Error("not a stargate default type");
  return type.decode(cs.msg.proto);
}
