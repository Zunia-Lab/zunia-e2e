/**
 * What the stack specs check a signature with: the bytes a chain rebuilds
 * (A1 for amino, the SignDoc for direct), never the wallet's own say-so. The
 * documents come from the signing harness (signing/), so the specs and the
 * harness sign the same shapes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { MsgGrant } from "osmojs/cosmos/authz/v1beta1/tx.js";
import { GenericAuthorization } from "osmojs/cosmos/authz/v1beta1/authz.js";
import { MsgExecuteContract } from "osmojs/cosmwasm/wasm/v1/tx.js";
import { aminoSignBytes } from "../../signing/amino-json";
import { XCS, directSignDoc, fromBase64 } from "../../signing/cases";
import { P1_FEATURES, P1_OPTIONAL_FEATURES } from "../../signing/expectations";

export { XCS };

/** The memo the amino checks sign: the characters the chain escapes. */
export const ESCAPED_MEMO = "zunia e2e & <check>";

export function manifestVersion(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version: string }).version;
}

export interface ProviderIdentity {
  version: unknown;
  extensionVersion: unknown;
  isZunia: unknown;
  features: unknown;
  featuresFrozen: boolean;
}

/** Runs in the page: what `window.zunia` says about itself. */
export function readIdentity(): ProviderIdentity {
  const zunia = (window as unknown as { zunia: Record<string, unknown> }).zunia;
  const features = zunia.features;
  return {
    version: zunia.version,
    extensionVersion: zunia.extensionVersion,
    isZunia: zunia.isZunia,
    features: Array.isArray(features) ? [...features] : features,
    featuresFrozen: Array.isArray(features) && Object.isFrozen(features),
  };
}

/** P1: the provider API version stays 0.1.0; the release, the marker and what it signs are new in 0.1.5. */
export function expectProviderIdentity(identity: ProviderIdentity, version: string): void {
  expect(identity.version).toBe("0.1.0");
  expect(identity.extensionVersion).toBe(version);
  expect(identity.isZunia).toBe(true);
  expect(identity.features).toEqual(expect.arrayContaining([...P1_FEATURES]));
  for (const feature of identity.features as string[]) {
    expect([...P1_FEATURES, ...P1_OPTIONAL_FEATURES]).toContain(feature);
  }
  expect(identity.featuresFrozen).toBe(true);
}

export interface StdSignature {
  pub_key: { type?: string; value: string };
  signature: string;
}

/** The chain's amino check: the signature verifies over the A1 bytes with `pubkey`. */
export function aminoSignatureVerifies(signed: unknown, signature: StdSignature, pubkey: Uint8Array): boolean {
  return verifies(signature.signature, aminoSignBytes(signed), pubkey);
}

export function verifies(signatureB64: string, signBytes: Uint8Array, pubkey: Uint8Array): boolean {
  try {
    return secp256k1.verify(fromBase64(signatureB64), sha256(signBytes), pubkey, { prehash: false });
  } catch {
    return false;
  }
}

/** Plain arrays for page.evaluate; the page turns them back into bytes. */
export interface DirectDocArgs {
  bodyBytes: number[];
  authInfoBytes: number[];
  chainId: string;
  accountNumber: string;
}

/** A contract call to a 32-byte contract, the shape 0.1.4 refuses in direct mode. */
export function contractCallDoc(input: { chainId: string; sender: string; pubkey: Uint8Array; memo?: string }) {
  const value = MsgExecuteContract.encode(
    MsgExecuteContract.fromPartial({ sender: input.sender, contract: XCS, msg: new TextEncoder().encode('{"recover":{}}'), funds: [] }),
  ).finish();
  return directDoc(input, [{ typeUrl: MsgExecuteContract.typeUrl, value }]);
}

/** An authz grant: no Zunia build decodes it, so direct signing is refused and the type is named. */
export function grantDoc(input: { chainId: string; sender: string; pubkey: Uint8Array }) {
  const value = MsgGrant.encode(
    MsgGrant.fromPartial({
      granter: input.sender,
      grantee: input.sender,
      grant: {
        authorization: GenericAuthorization.fromPartial({ msg: "/cosmos.bank.v1beta1.MsgSend" }),
        expiration: new Date("2027-01-01T00:00:00Z"),
      },
    }),
  ).finish();
  return directDoc(input, [{ typeUrl: MsgGrant.typeUrl, value }]);
}

function directDoc(input: { chainId: string; pubkey: Uint8Array; memo?: string }, messages: Array<{ typeUrl: string; value: Uint8Array }>) {
  const accountNumber = "0";
  const doc = directSignDoc({ messages, memo: input.memo ?? "", pubkey: input.pubkey, chainId: input.chainId, accountNumber, sequence: "0" });
  const args: DirectDocArgs = {
    bodyBytes: Array.from(doc.bodyBytes),
    authInfoBytes: Array.from(doc.authInfoBytes),
    chainId: input.chainId,
    accountNumber,
  };
  return { args, signBytes: doc.signBytes };
}
