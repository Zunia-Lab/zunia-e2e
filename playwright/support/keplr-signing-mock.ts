/**
 * A Keplr-shaped wallet that really signs, for the signing suite
 * (signing.spec.ts). It speaks Keplr's provider API (version, mode, enable,
 * getKey, experimentalSuggestChain, getChainInfosWithoutEndpoints, signAmino,
 * signDirect, signArbitrary, the offline signers, disable) and signs with
 * CosmJS from the public "abandon … about" phrase: the bytes Keplr signs.
 *
 * CosmJS is bundled with this file's installer into one IIFE (esbuild) and
 * injected before any page script runs. The read-only wallet of the dashboard
 * suite (mock-wallet.ts) stays as it is: this one exists for the specs that
 * sign, against a dashboard on this machine only.
 *
 * `behaviour: "other-bytes"` makes it a broken wallet: it returns the document
 * it was given with a signature over a different memo, which a dashboard must
 * catch before broadcasting.
 */

import { Secp256k1HdWallet, type StdSignDoc } from "@cosmjs/amino";
import { stringToPath } from "@cosmjs/crypto";
import { fromBech32, toBase64 } from "@cosmjs/encoding";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import type { BrowserContext, Page } from "@playwright/test";

export interface KeplrMockChain {
  prefix: string;
  coinType: number;
}

export interface KeplrSigningMockConfig {
  mnemonic: string;
  /** chain id → the key the wallet holds there. Others answer "There is no chain info for …", as Keplr does. */
  chains: Record<string, KeplrMockChain>;
  /** Write the dashboard's reconnect hint so every load restores the wallet. */
  restore: { chainId: string; chains: string[] } | null;
  name: string;
  behaviour: "honest" | "other-bytes";
}

/** What the wallet did, read back by the spec (`keplrMockCalls`). */
export interface KeplrMockCall {
  method: "signAmino" | "signDirect" | "signArbitrary";
  chainId: string;
  signer: string;
}

interface DirectDocLike {
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  chainId: string;
  accountNumber: unknown;
}

/**
 * Runs in the page, from the bundle. Self-contained apart from CosmJS, which
 * the bundle carries.
 */
export function installKeplrSigningMock(config: KeplrSigningMockConfig): void {
  const calls: KeplrMockCall[] = [];
  const keys = new Map<string, Promise<{ amino: Secp256k1HdWallet; direct: DirectSecp256k1HdWallet; address: string; pubkey: Uint8Array }>>();
  const keyFor = (chainId: string) => {
    const chain = config.chains[chainId];
    if (!chain) return Promise.reject(new Error(`There is no chain info for ${chainId}`));
    let key = keys.get(chainId);
    if (!key) {
      const hdPaths = [stringToPath(`m/44'/${chain.coinType}'/0'/0/0`)];
      key = Promise.all([
        Secp256k1HdWallet.fromMnemonic(config.mnemonic, { prefix: chain.prefix, hdPaths }),
        DirectSecp256k1HdWallet.fromMnemonic(config.mnemonic, { prefix: chain.prefix, hdPaths }),
      ]).then(async ([amino, direct]) => {
        const [account] = await direct.getAccounts();
        if (!account) throw new Error("The mock wallet has no account");
        return { amino, direct, address: account.address, pubkey: account.pubkey };
      });
      keys.set(chainId, key);
    }
    return key;
  };
  const own = async (chainId: string, signer: string) => {
    const key = await keyFor(chainId);
    if (key.address !== signer) throw new Error(`Signer address does not match: ${signer}`);
    return key;
  };

  const signAmino = async (chainId: string, signer: string, signDoc: StdSignDoc) => {
    const key = await own(chainId, signer);
    calls.push({ method: "signAmino", chainId, signer });
    const signedOver = config.behaviour === "other-bytes" ? { ...signDoc, memo: `${signDoc.memo} ` } : signDoc;
    const answer = await key.amino.signAmino(signer, signedOver);
    return { signed: signDoc, signature: answer.signature };
  };
  const signDirect = async (chainId: string, signer: string, signDoc: DirectDocLike) => {
    const key = await own(chainId, signer);
    calls.push({ method: "signDirect", chainId, signer });
    const doc = {
      bodyBytes: signDoc.bodyBytes,
      authInfoBytes: signDoc.authInfoBytes,
      chainId: signDoc.chainId,
      accountNumber: BigInt(String(signDoc.accountNumber)),
    };
    const signedOver =
      config.behaviour === "other-bytes" ? { ...doc, authInfoBytes: Uint8Array.from([...doc.authInfoBytes, 0x18, 0x01]) } : doc;
    const answer = await key.direct.signDirect(signer, signedOver);
    return { signed: signDoc, signature: answer.signature };
  };
  const signArbitrary = async (chainId: string, signer: string, data: string | Uint8Array) => {
    const key = await own(chainId, signer);
    calls.push({ method: "signArbitrary", chainId, signer });
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const doc: StdSignDoc = {
      chain_id: "",
      account_number: "0",
      sequence: "0",
      fee: { gas: "0", amount: [] },
      msgs: [{ type: "sign/MsgSignData", value: { signer, data: toBase64(bytes) } }],
      memo: "",
    };
    return (await key.amino.signAmino(signer, doc)).signature;
  };
  const offlineSigner = (chainId: string, withDirect: boolean) => ({
    chainId,
    getAccounts: async () => {
      const key = await keyFor(chainId);
      return [{ address: key.address, algo: "secp256k1" as const, pubkey: key.pubkey }];
    },
    signAmino: (signer: string, doc: StdSignDoc) => signAmino(chainId, signer, doc),
    ...(withDirect ? { signDirect: (signer: string, doc: DirectDocLike) => signDirect(chainId, signer, doc) } : {}),
  });

  const keplr = {
    version: "0.12.150",
    mode: "extension",
    defaultOptions: {},
    enable: async (chainIds: string | string[]) => {
      for (const chainId of [chainIds].flat()) await keyFor(chainId);
    },
    disable: async () => undefined,
    getKey: async (chainId: string) => {
      const key = await keyFor(chainId);
      return {
        name: config.name,
        algo: "secp256k1",
        pubKey: key.pubkey,
        address: fromBech32(key.address).data,
        bech32Address: key.address,
        isNanoLedger: false,
        isKeystone: false,
      };
    },
    experimentalSuggestChain: async () => undefined,
    getChainInfosWithoutEndpoints: async () => Object.keys(config.chains).map((chainId) => ({ chainId })),
    signAmino,
    signDirect,
    signArbitrary,
    getOfflineSigner: (chainId: string) => offlineSigner(chainId, true),
    getOfflineSignerOnlyAmino: (chainId: string) => offlineSigner(chainId, false),
    getOfflineSignerAuto: async (chainId: string) => offlineSigner(chainId, true),
  };
  Object.defineProperty(window, "keplr", { value: keplr, configurable: true, writable: true });
  Object.defineProperty(window, "__keplrSigningMock", { value: { calls }, configurable: true });
  if (!config.restore) return;
  try {
    window.localStorage.setItem(
      "zunia.dashboard.walletHint",
      JSON.stringify({ mode: "extension", wallet: "keplr", chainId: config.restore.chainId, chains: config.restore.chains }),
    );
  } catch {
    // about:blank and sandboxed frames have no storage; the top page does.
  }
}

let bundled: Promise<string> | null = null;

/** CosmJS and the installer as one IIFE that defines `installKeplrSigningMock` on a global. Built once per run. */
async function bundle(): Promise<string> {
  bundled ??= (async () => {
    const esbuild = await import("esbuild");
    const result = await esbuild.build({
      stdin: {
        contents: 'import { installKeplrSigningMock } from "./keplr-signing-mock";\nglobalThis.__installKeplrSigningMock = installKeplrSigningMock;\n',
        resolveDir: __dirname,
        sourcefile: "keplr-signing-mock-entry.ts",
        loader: "ts",
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      // CosmJS reaches for Node's crypto inside try/catch and falls back to Web Crypto.
      external: ["esbuild", "@playwright/test", "crypto"],
      write: false,
      logLevel: "silent",
    });
    const [file] = result.outputFiles;
    if (!file) throw new Error("esbuild wrote no bundle");
    return file.text;
  })();
  return bundled;
}

/** Injects the signing Keplr into every page the context opens from now on. */
export async function installKeplrSigningMockInto(context: BrowserContext, config: KeplrSigningMockConfig): Promise<void> {
  await context.addInitScript({
    content: `${await bundle()}\nglobalThis.__installKeplrSigningMock(${JSON.stringify(config)});`,
  });
}

/** Every signing call the wallet answered, in order. */
export function keplrMockCalls(page: Page): Promise<KeplrMockCall[]> {
  return page.evaluate(() => (window as unknown as { __keplrSigningMock?: { calls: KeplrMockCall[] } }).__keplrSigningMock?.calls ?? []);
}
