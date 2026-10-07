/**
 * What each build is expected to do with each case, so a run is judged
 * against the build it ran on: a legacy build must still fail exactly where it
 * is known to (which shows the harness can see the bugs), and 0.1.5 must sign
 * everything the chain accepts.
 *
 * The legacy defects, from the 2026-10-07 investigation:
 * - the 0.1.0 kernel's direct decoder refuses 32-byte addresses (contracts,
 *   sends to contracts), exact-out swaps and types it does not know;
 * - 0.1.3's kernel does not decode Osmosis poolmanager swaps either;
 * - amino documents are signed without the &, <, > (and U+2028) escaping the
 *   chain applies, so those signatures are invalid;
 * - amino types without "Msg" (Osmosis poolmanager) are refused;
 * - an account added with its own phrase signs at its row index instead of
 *   its derivation index 0, so its signatures are invalid.
 */

import { needsEscaping } from "./amino-json";
import type { AccountRole, SigningCase } from "./cases";
import type { Build } from "./env";
import type { SignMode } from "./oracle";

export type Outcome = "VALID" | "INVALID" | "REFUSED";

export interface Expected {
  outcome: Outcome;
  /** Why a row is not VALID. */
  why?: string;
}

export const LEGACY_REFUSAL = "Blind signing disabled for unknown messages";

/** R1: the refusal names the unreadable types (at most five). */
export function refusalNaming(types: string[]): string {
  return types.length > 0 ? `${LEGACY_REFUSAL}: ${types.slice(0, 5).join(", ")}` : LEGACY_REFUSAL;
}

/** P1: what `features` lists from 0.1.5. The amino poolmanager entry ships with E3 only. */
export const P1_FEATURES = [
  "sign-direct:wasm-contract-32",
  "sign-direct:send-32",
  "sign-direct:osmosis-poolmanager",
  "sign-direct:osmosis-exact-out",
  "sign-amino:escaped",
] as const;
export const P1_OPTIONAL_FEATURES = ["sign-amino:osmosis-poolmanager"] as const;

const LEGACY_DECODER_GAPS: Record<NonNullable<SigningCase["legacyDecoder"]>, string> = {
  "32-byte address": "a 32-byte address",
  "exact-out swap": "an exact-out swap",
  "unknown type": "this type",
};

export function isLegacy(build: Build): boolean {
  return build !== "0.1.5";
}

/** Tier 1: a whole extension build signing one case in one mode. */
export function expectedForBuild(build: Build, cs: SigningCase, mode: SignMode, doc?: unknown): Expected {
  if (!isLegacy(build)) {
    if (mode === "direct" && cs.prompt.direct === null) return { outcome: "REFUSED", why: "no build decodes this type" };
    return { outcome: "VALID" };
  }
  if (mode === "direct") {
    if (cs.legacyDecoder) return { outcome: "REFUSED", why: `the 0.1.0 kernel cannot decode ${LEGACY_DECODER_GAPS[cs.legacyDecoder]}` };
    if (build === "0.1.3" && cs.poolmanager) return { outcome: "REFUSED", why: "0.1.3 does not decode poolmanager swaps" };
  } else {
    if (!cs.msg.amino.type.includes("Msg")) return { outcome: "REFUSED", why: "amino types without 'Msg' are refused" };
    if (doc !== undefined && needsEscaping(doc)) return { outcome: "INVALID", why: "signs & < > U+2028 unescaped" };
  }
  if (cs.account === "added") return { outcome: "INVALID", why: "an added account signs at its row index" };
  return { outcome: "VALID" };
}

/** Tier 1: signArbitrary (sign-in) from an account. */
export function expectedArbitrary(build: Build, account: AccountRole): Expected {
  if (isLegacy(build) && account === "added") return { outcome: "INVALID", why: "an added account signs at its row index" };
  return { outcome: "VALID" };
}

/** Tier 0: whether the build's kernel decoder prompts for a case in direct mode. */
export function expectedDecode(build: Build, cs: SigningCase): "prompts" | "refused" {
  if (cs.prompt.direct === null) return "refused";
  if (isLegacy(build) && cs.legacyDecoder) return "refused";
  if (build === "0.1.3" && cs.poolmanager) return "refused";
  return "prompts";
}

/** Tier 0: whether the build's amino serializer writes the A1 bytes for a document. */
export function expectedSerializer(build: Build, doc: unknown): "== A1" | "!= A1" {
  return !isLegacy(build) || !needsEscaping(doc) ? "== A1" : "!= A1";
}
