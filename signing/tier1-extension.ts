/**
 * Tier 1: the real extension build (EXT_DIR, unpacked) in a throwaway Chromium
 * profile, restored from the public "abandon … about" phrase. Every case is
 * sent through `window.zunia` exactly as a dApp sends it, in direct and in
 * amino mode, approved from the extension's own queue, and the signature it
 * returns is checked with secp256k1 against the bytes the chain rebuilds (A1).
 * Then an account is added with its own phrase ("legal winner … yellow"),
 * made active, and its amino, direct and signArbitrary signatures are checked
 * against that phrase's index-0 key. Nothing is broadcast: the page is a blank
 * local page.
 *
 * Judged as 0.1.5 (every row VALID except direct MsgGrant, refused with its
 * type named; the F1 sentences; the contract body and packet memo in the
 * approval's JSON; P1) unless SIGNING_EXPECT names a legacy build, which is
 * then expected to fail exactly where it is known to:
 *
 *   EXT_DIR=…/zunia-extension/.output/chrome-mv3 pnpm test:signing:extension
 *   SIGNING_EXPECT=0.1.4 EXT_DIR=…/ext-014 pnpm test:signing:extension
 *   HEADED=1 to watch it, ONLY=<regex> for some cases.
 */

import { existsSync } from "node:fs";
import { toHex } from "@cosmjs/encoding";
import type { Page } from "@playwright/test";
import { adr36SignDoc, aminoSignBytes } from "./amino-json";
import {
  ADDED_MNEMONIC,
  MNEMONIC,
  OSMOSIS,
  aminoReference,
  directReference,
  judge,
  loadReference,
  type AccountRole,
  type Reference,
  type SigningCase,
} from "./cases";
import {
  CHAINS,
  connectSite,
  importWallet,
  launchExtension,
  readProviderIdentity,
  request,
  startBlankSite,
  waitForActiveAddress,
  type ApprovalItem,
  type ExtensionSession,
  type ProviderIdentity,
  type Request,
} from "./browser";
import { EXT_DIR, ONLY, expectedBuild, type Build } from "./env";
import {
  LEGACY_REFUSAL,
  P1_FEATURES,
  P1_OPTIONAL_FEATURES,
  expectedArbitrary,
  expectedForBuild,
  isLegacy,
  refusalNaming,
  type Expected,
  type Outcome,
} from "./expectations";
import type { SignMode } from "./oracle";
import { Findings, containsValue, printTable, run } from "./report";

const SIGN_IN_TEXT = "Zunia e2e: sign in to the signing harness";

interface Row {
  case: string;
  mode: string;
  outcome: string;
  expected: string;
  prompt: string;
  detail: string;
  baseline: boolean;
}

interface Signed {
  signed?: unknown;
  signature: { signature: string; pub_key: { value: string } };
}

function outcomeOf(result: Request["result"], valid: boolean): { outcome: Outcome; label: string } {
  if (!result.ok) return { outcome: "REFUSED", label: `REFUSED ${result.code ?? "?"}` };
  return valid ? { outcome: "VALID", label: "VALID" } : { outcome: "INVALID", label: "INVALID" };
}

function warningsOf(approval: ApprovalItem | null): string[] {
  return [...(approval?.warnings ?? []), ...(approval?.detail?.summary?.warnings ?? [])];
}

function checkIdentity(findings: Findings, build: Build, identity: ProviderIdentity, manifestVersion: string): void {
  findings.expect("provider", "version", identity.version, "0.1.0");
  if (isLegacy(build)) {
    findings.expect("provider", "extensionVersion", identity.extensionVersion, undefined);
    findings.expect("provider", "features", identity.features, undefined);
    return;
  }
  findings.expect("provider", "extensionVersion", identity.extensionVersion, manifestVersion);
  findings.expect("provider", "isZunia", identity.isZunia, true);
  const features = Array.isArray(identity.features) ? (identity.features as string[]) : [];
  for (const feature of P1_FEATURES) findings.require("provider", features.includes(feature), `features lacks "${feature}"`);
  const known = new Set<string>([...P1_FEATURES, ...P1_OPTIONAL_FEATURES]);
  for (const feature of features) findings.require("provider", known.has(feature), `features has an unknown "${feature}"`);
  findings.require("provider", identity.featuresFrozen, "features is not a frozen array");
}

/** Checks one signing row against the build's expectations and returns its table row. */
function judgeRow(input: {
  findings: Findings;
  build: Build;
  cs: SigningCase;
  mode: SignMode;
  outcome: { outcome: Outcome; label: string };
  expected: Expected;
  request: Request;
  detail: string;
}): Row {
  const { findings, build, cs, mode, outcome, expected, request: sent } = input;
  const row = `${cs.name} (${mode})`;
  findings.expect(row, "outcome", outcome.outcome, expected.outcome);
  const prompt = sent.approval?.detail?.summary?.messages?.map((message) => message.summary).join(" | ") ?? "";
  if (!sent.result.ok) {
    // R1 from 0.1.5: the refusal names the type it could not read.
    if (expected.outcome === "REFUSED") {
      findings.expect(row, "refusal", sent.result.message, isLegacy(build) ? LEGACY_REFUSAL : refusalNaming([cs.msg.typeUrl]));
    }
  } else if (!isLegacy(build)) {
    // F1: the same sentence in both modes; the contract body and packet memo in the JSON.
    findings.expect(row, "prompt", prompt, cs.prompt[mode]);
    let json: unknown = null;
    try {
      json = JSON.parse(sent.approval?.detail?.json ?? "null");
    } catch {
      json = sent.approval?.detail?.json ?? null;
    }
    for (const value of cs.json) findings.require(row, containsValue(json, value), `the approval JSON lacks ${JSON.stringify(value).slice(0, 60)}`);
    const warnings = warningsOf(sent.approval);
    for (const warning of cs.warnings) findings.require(row, warnings.includes(warning), `the prompt lacks the warning "${warning}"`);
  }
  return {
    case: cs.name,
    mode,
    outcome: outcome.label,
    expected: expected.outcome === "VALID" ? "VALID" : `${expected.outcome} (${expected.why ?? ""})`,
    prompt: sent.result.ok ? prompt : sent.result.message,
    detail: input.detail,
    baseline: cs.baseline,
  };
}

async function signCase(
  session: ExtensionSession,
  page: Page,
  reference: Reference,
  cs: SigningCase,
  mode: SignMode,
  build: Build,
  findings: Findings,
): Promise<Row> {
  if (mode === "direct") {
    const d = await directReference(reference, cs);
    const doc = { bodyBytes: Array.from(d.bodyBytes), authInfoBytes: Array.from(d.authInfoBytes), chainId: cs.chain.chainId, accountNumber: "12345" };
    const sent = await request(session, page, "signDirect", [cs.chain.chainId, d.signer, doc, { preferNoSetFee: true }]);
    let valid = false;
    let detail = sent.result.ok ? "" : sent.result.message;
    if (sent.result.ok) {
      const answer = sent.result.value as Signed & { signed: { bodyBytes: number[]; authInfoBytes: number[] } };
      const unchanged =
        toHex(Uint8Array.from(answer.signed.bodyBytes)) === toHex(d.bodyBytes) &&
        toHex(Uint8Array.from(answer.signed.authInfoBytes)) === toHex(d.authInfoBytes);
      const verdict = judge(answer.signature.signature, answer.signature.pub_key.value, d.signBytes, d.referenceSignature, d.pubkey);
      valid = verdict.valid && verdict.sameKey && unchanged;
      detail = `verifies=${verdict.valid} sameKey=${verdict.sameKey} ==reference=${verdict.equalsReference} docUnchanged=${unchanged}`;
    }
    const expected = expectedForBuild(build, cs, "direct");
    return judgeRow({ findings, build, cs, mode, outcome: outcomeOf(sent.result, valid), expected, request: sent, detail });
  }
  const a = await aminoReference(reference, cs);
  const sent = await request(session, page, "signAmino", [cs.chain.chainId, a.signer, a.doc, { preferNoSetFee: true }]);
  let valid = false;
  let detail = sent.result.ok ? "" : sent.result.message;
  if (sent.result.ok) {
    const answer = sent.result.value as Signed;
    const unchanged = JSON.stringify(answer.signed) === JSON.stringify(a.doc);
    const verdict = judge(answer.signature.signature, answer.signature.pub_key.value, a.signBytes, a.referenceSignature, a.pubkey);
    valid = verdict.valid && verdict.sameKey && unchanged;
    detail = `verifies=${verdict.valid} sameKey=${verdict.sameKey} ==reference=${verdict.equalsReference} docUnchanged=${unchanged}`;
  }
  const expected = expectedForBuild(build, cs, "amino", a.doc);
  return judgeRow({ findings, build, cs, mode, outcome: outcomeOf(sent.result, valid), expected, request: sent, detail });
}

/** signArbitrary (ADR-36), the sign-in path, from the active account. */
async function signArbitrary(
  session: ExtensionSession,
  page: Page,
  reference: Reference,
  account: AccountRole,
  build: Build,
  findings: Findings,
): Promise<Row> {
  const key = reference.keys[account].osmo;
  const sent = await request(session, page, "signArbitrary", [OSMOSIS.chainId, key.address, SIGN_IN_TEXT]);
  let valid = false;
  let detail = sent.result.ok ? "" : sent.result.message;
  if (sent.result.ok) {
    const answer = sent.result.value as Signed["signature"];
    const bytes = aminoSignBytes(adr36SignDoc(key.address, new TextEncoder().encode(SIGN_IN_TEXT)));
    const verdict = judge(answer.signature, answer.pub_key.value, bytes, key.sign(bytes), key.pubkey);
    valid = verdict.valid && verdict.sameKey;
    detail = `verifies=${verdict.valid} sameKey=${verdict.sameKey} ==reference=${verdict.equalsReference}`;
  }
  const name = `signArbitrary sign-in (${account === "added" ? "added account" : "first account"})`;
  const outcome = outcomeOf(sent.result, valid);
  const expected = expectedArbitrary(build, account);
  findings.expect(`${name}`, "outcome", outcome.outcome, expected.outcome);
  return {
    case: name,
    mode: "arbitrary",
    outcome: outcome.label,
    expected: expected.outcome === "VALID" ? "VALID" : `${expected.outcome} (${expected.why ?? ""})`,
    prompt: sent.approval?.title ?? "",
    detail,
    baseline: false,
  };
}

run(async () => {
  if (!existsSync(`${EXT_DIR}/manifest.json`)) throw new Error(`No unpacked build at ${EXT_DIR}. Set EXT_DIR.`);
  const build = expectedBuild();
  const reference = await loadReference();
  const findings = new Findings();
  const rows: Row[] = [];
  const site = await startBlankSite();
  const session = await launchExtension(EXT_DIR);
  try {
    await importWallet(session, MNEMONIC);
    const page = await session.context.newPage();
    await page.goto(site.url);
    const identity = await readProviderIdentity(page);
    console.log(`extension ${session.version} from ${EXT_DIR}, judged as Zunia ${build}${process.env.SIGNING_EXPECT ? " (SIGNING_EXPECT)" : ""}`);
    console.log(`provider: ${JSON.stringify(identity)}`);
    checkIdentity(findings, build, identity, session.version);
    await connectSite(page);

    const selected = reference.cases.filter((cs) => !ONLY || ONLY.test(cs.name));
    for (const cs of selected.filter((item) => item.account === "main")) {
      for (const mode of ["direct", "amino"] as const) rows.push(await signCase(session, page, reference, cs, mode, build, findings));
    }
    rows.push(await signArbitrary(session, page, reference, "main", build, findings));

    // An account added with its own phrase, then made the active one.
    const added = await session.send<{ index: number }>({
      type: "ADD_ACCOUNT_SEED",
      payload: { mnemonic: ADDED_MNEMONIC, name: "Own phrase", enabledChainIds: CHAINS },
    });
    if (!added.ok || typeof added.data?.index !== "number") throw new Error(`ADD_ACCOUNT_SEED failed: ${added.error ?? "no index"}`);
    const switched = await session.send({ type: "SET_ACTIVE_ACCOUNT", payload: { index: added.data.index } });
    if (!switched.ok) throw new Error(`SET_ACTIVE_ACCOUNT failed: ${switched.error ?? "no reason"}`);
    await waitForActiveAddress(page, OSMOSIS.chainId, reference.keys.added.osmo.address);
    for (const cs of selected.filter((item) => item.account === "added")) {
      for (const mode of ["direct", "amino"] as const) rows.push(await signCase(session, page, reference, cs, mode, build, findings));
    }
    rows.push(await signArbitrary(session, page, reference, "added", build, findings));
  } finally {
    await session.close();
    site.close();
  }

  printTable(rows.map(({ baseline: _baseline, ...row }) => row), 60);
  const valid = rows.filter((row) => row.outcome === "VALID").length;
  const baseline = rows.filter((row) => row.baseline);
  const baselineValid = baseline.filter((row) => row.outcome === "VALID").length;
  findings.finish(
    `${baselineValid}/${baseline.length} valid on the 2026-10-07 matrix (16 cases × 2 modes; 0.1.3 had 23, 0.1.4 had 25); ` +
      `${valid}/${rows.length} valid on every row; nothing was broadcast.`,
  );
});
