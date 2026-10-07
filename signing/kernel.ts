import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fromHex, toHex } from "@cosmjs/encoding";
import { unescapedAminoBytes } from "./amino-json";
import type { ChainRef } from "./cases";
import { EXT_SRC, KERNEL } from "./env";

/** One message of the decode payload from kernel 0.1.1 (contract K1). */
export interface DecodedMessage {
  typeUrl: string;
  summary: string;
  unknown: boolean;
  recipient?: string;
  detail?: Record<string, unknown>;
}

/**
 * What `decodeDirectTx` answers. The first six fields exist in every kernel;
 * the rest are payload v2 (kernel 0.1.1, K1) and absent before it.
 */
export interface DecodedDirectTx {
  chainId: string;
  memo: string;
  hasUnknownMsgs: boolean;
  safeWithoutBlindSigning: boolean;
  summaries: string[];
  addresses: string[];
  accountNumber?: string;
  sequence?: string;
  timeoutHeight?: string;
  fee?: { amount: Array<{ denom: string; amount: string }>; gasLimit: string };
  messages?: DecodedMessage[];
}

/** The part of @zunialab/core's Node entry the harness calls. */
export interface Kernel {
  kernelVersion(): string;
  decodeDirectTx(signDocHex: string): DecodedDirectTx;
  signCosmos(phrase: string, passphrase: string, chainJson: string, accountIndex: number, signBytesHex: string): string;
  deriveAddress(
    phrase: string,
    passphrase: string,
    chainJson: string,
    accountIndex: number,
  ): { address: string; publicKeyHex: string; path: string };
}

export async function loadKernel(path: string = KERNEL): Promise<Kernel> {
  if (!existsSync(path)) {
    throw new Error(`No kernel at ${path}. Build zunia-core (pnpm build:wasm) or point KERNEL at a node/index.mjs.`);
  }
  return (await import(pathToFileURL(path).href)) as Kernel;
}

/** The sha256 of the wasm next to a kernel entry, to say exactly which kernel ran. */
export function kernelWasmSha256(path: string = KERNEL): string | null {
  const wasm = join(dirname(path), "..", "zunia_core_bg.wasm");
  if (!existsSync(wasm)) return null;
  return createHash("sha256").update(readFileSync(wasm)).digest("hex");
}

function versionParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

/** Semantic order of two x.y.z versions: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Kernel 0.1.1 (zunia-core C1 and C2) is the first to read 32-byte addresses and exact-out swaps. */
export function kernelIsFixed(kernel: Kernel): boolean {
  return compareVersions(kernel.kernelVersion(), "0.1.1") >= 0;
}

/** A minimal chain description the kernel accepts for signing. */
export function chainJson(chain: ChainRef): string {
  return JSON.stringify({
    chainId: chain.chainId,
    chainName: chain.chainId,
    rpc: "https://rpc.invalid",
    rest: "https://rest.invalid",
    bip44: { coinType: 118 },
    bech32Config: { bech32PrefixAccAddr: chain.prefix },
    currencies: [{ coinDenom: chain.denom, coinMinimalDenom: chain.denom, coinDecimals: 6 }],
    feeCurrencies: [
      {
        coinDenom: chain.denom,
        coinMinimalDenom: chain.denom,
        coinDecimals: 6,
        gasPriceStep: { low: 0.01, average: 0.025, high: 0.04 },
      },
    ],
    features: [],
    bech32Prefix: chain.prefix,
    coinType: 118,
  });
}

/** The kernel's signature over `bytes` at BIP-44 index `accountIndex`: the 64 bytes r‖s. */
export function kernelSign(kernel: Kernel, mnemonic: string, chain: ChainRef, bytes: Uint8Array, accountIndex = 0): Uint8Array {
  return fromHex(kernel.signCosmos(mnemonic, "", chainJson(chain), accountIndex, toHex(bytes)).slice(0, 128));
}

export interface ExtensionSerializer {
  serialize(doc: unknown): Uint8Array;
  /** Where it came from: the extension's lib/kernel.ts, or the 0.1.4 replica. */
  source: string;
  /** Writes &, <, > and U+2028 the way A1 does. */
  escapes: boolean;
}

/**
 * The extension's own `serializeAminoSignDoc` (lib/kernel.ts), imported from
 * EXT_SRC so a fixed source tree is picked up as it is. The 0.1.4 replica
 * (sorted JSON.stringify, no escaping) stands in only when SIGNING_REPLICA=1.
 */
export async function loadExtensionSerializer(source: string = EXT_SRC): Promise<ExtensionSerializer> {
  let serialize: (doc: unknown) => Uint8Array;
  let origin: string;
  if (process.env.SIGNING_REPLICA === "1") {
    serialize = unescapedAminoBytes;
    origin = "replica of 0.1.4 (SIGNING_REPLICA=1)";
  } else {
    const file = join(source, "lib/kernel.ts");
    if (!existsSync(file)) throw new Error(`No extension source at ${file}. Set EXT_SRC to a zunia-extension checkout.`);
    const module = (await import(pathToFileURL(file).href)) as { serializeAminoSignDoc(doc: unknown): Uint8Array };
    serialize = module.serializeAminoSignDoc;
    origin = file;
  }
  const probe = new TextDecoder().decode(serialize({ memo: "<a & b>\u2028" }));
  return { serialize, source: origin, escapes: probe === '{"memo":"\\u003ca \\u0026 b\\u003e\\u2028"}' };
}

/** The extension's version as its package.json says. */
export function extensionSourceVersion(source: string = EXT_SRC): string {
  try {
    return (JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}
