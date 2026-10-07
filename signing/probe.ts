/**
 * A quick look at an extension build, without signing anything: what the
 * provider says about itself (P1), the shape of `getKey`, the Keplr surface it
 * exposes, and whether a few documents reach a prompt or are refused. Every
 * prompt is rejected from the extension's own queue, so nothing is signed or
 * broadcast. A diagnostic, not a gate: Tier 1 is the gate.
 *
 *   EXT_DIR=…/chrome-mv3 pnpm exec tsx signing/probe.ts
 */

import { existsSync } from "node:fs";
import { MNEMONIC, aminoReference, directReference, loadReference } from "./cases";
import { connectSite, importWallet, launchExtension, readProviderIdentity, request, startBlankSite } from "./browser";
import { EXT_DIR } from "./env";
import { run } from "./report";

/** Cases whose answer differs between builds. */
const PROBES: Array<{ name: string; mode: "direct" | "amino" }> = [
  { name: "ExecuteContract XCS (32-byte)", mode: "direct" },
  { name: "ExecuteContract recover (32-byte, no funds)", mode: "direct" },
  { name: "MsgSend to a 32-byte address", mode: "direct" },
  { name: "poolmanager exact-out", mode: "direct" },
  { name: "authz MsgGrant", mode: "direct" },
  { name: "MsgSend memo 'a & b <c>'", mode: "amino" },
  { name: "gov v1beta1 MsgVote", mode: "amino" },
  { name: "poolmanager exact-in", mode: "amino" },
];

run(async () => {
  if (!existsSync(`${EXT_DIR}/manifest.json`)) throw new Error(`No unpacked build at ${EXT_DIR}. Set EXT_DIR.`);
  const reference = await loadReference();
  const site = await startBlankSite();
  const session = await launchExtension(EXT_DIR);
  try {
    await importWallet(session, MNEMONIC);
    const page = await session.context.newPage();
    await page.goto(site.url);
    console.log(`extension ${session.version} from ${EXT_DIR}`);
    console.log("provider:", JSON.stringify(await readProviderIdentity(page)));
    await connectSite(page);
    console.log(
      "getKey:",
      JSON.stringify(
        await page.evaluate(async () => {
          const key = await (window as unknown as { zunia: { getKey(id: string): Promise<Record<string, unknown>> } }).zunia.getKey("osmosis-1");
          return { bech32Address: key.bech32Address, address: key.address instanceof Uint8Array ? "Uint8Array" : typeof key.address, algo: key.algo };
        }),
      ),
    );
    console.log(
      "keplr surface:",
      JSON.stringify(
        await page.evaluate(() => {
          const w = window as unknown as Record<string, unknown> & { zunia: Record<string, unknown> };
          return {
            keplrAlias: w.keplr === w.zunia,
            offlineSigners: ["getOfflineSigner", "getOfflineSignerOnlyAmino", "getOfflineSignerAuto"].filter((name) => typeof w.zunia[name] === "function"),
            windowGlobals: ["getOfflineSigner", "getOfflineSignerOnlyAmino", "getOfflineSignerAuto"].filter((name) => typeof w[name] === "function"),
          };
        }),
      ),
    );
    for (const probe of PROBES) {
      const cs = reference.cases.find((item) => item.name === probe.name);
      if (!cs) continue;
      const args =
        probe.mode === "direct"
          ? await directReference(reference, cs).then((d) => [
              cs.chain.chainId,
              d.signer,
              { bodyBytes: Array.from(d.bodyBytes), authInfoBytes: Array.from(d.authInfoBytes), chainId: cs.chain.chainId, accountNumber: "12345" },
            ])
          : await aminoReference(reference, cs).then((a) => [cs.chain.chainId, a.signer, a.doc]);
      const sent = await request(session, page, probe.mode === "direct" ? "signDirect" : "signAmino", args, { approve: false });
      const summary = sent.approval?.detail?.summary?.messages?.map((message) => message.summary).join(" | ");
      console.log(
        `${probe.name} (${probe.mode}): ${sent.approval ? `PROMPTED "${summary ?? ""}", rejected by the probe` : `refused: ${sent.result.ok ? "?" : sent.result.message}`}`,
      );
    }
  } finally {
    await session.close();
    site.close();
  }
});
