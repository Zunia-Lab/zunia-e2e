/**
 * A read-only stand-in for the Keplr extension, injected before any page
 * script runs (`addInitScript`), so the dashboard sees a wallet without a real
 * extension in the browser.
 *
 * It shares public addresses only: `enable` accepts every chain, `getKey`
 * answers the address of a chain from the map (and, like Keplr, "There is no
 * chain info for X" otherwise), and every signing call throws. Nothing it
 * holds can move funds, and `signAttempts(page)` counts any try.
 *
 * With `restore` (the default) it also writes the dashboard's reconnect hint
 * (`zunia.dashboard.walletHint`, see zunia-dashboard lib/connect/walletHint.ts),
 * so each page load restores the wallet the way a returning visitor's does,
 * without a click. Without it, connect from the UI ("Keplr · Connect").
 */

import type { BrowserContext, Page } from "@playwright/test";

/** The dashboard's first-visit followed chains (zunia-dashboard lib/followed-defaults.ts). */
export const DEFAULT_FOLLOWED = ["safrochain-1", "cosmoshub-4", "osmosis-1", "celestia", "akashnet-2"] as const;

export type AddressMap = Readonly<Record<string, string>>;

/**
 * A real retail wallet, read-only: about $47 across Cosmos Hub, Celestia,
 * Osmosis and Akash, ~30 assets, delegations including jailed validators,
 * a handful of transactions. Public chain data; never send funds to it.
 */
export const RETAIL_WALLET: AddressMap = {
  "safrochain-1": "addr_safro1qx8te2rzsdyj47q2hswzclqc52gp9njuhge00x",
  "cosmoshub-4": "cosmos1qx8te2rzsdyj47q2hswzclqc52gp9nju0yccyk",
  "osmosis-1": "osmo1qx8te2rzsdyj47q2hswzclqc52gp9nju8ltgjy",
  celestia: "celestia1qx8te2rzsdyj47q2hswzclqc52gp9nju7wfg7m",
  "akashnet-2": "akash1qx8te2rzsdyj47q2hswzclqc52gp9njuzl4lav",
};

/**
 * Busy public accounts, read-only: dozens of transactions in the nodes'
 * retention window, enough for the Activity list to page ("Load more").
 */
export const ACTIVE_WALLET: AddressMap = {
  "safrochain-1": "addr_safro1jz4fmzlc9lskmxum02elvml6jms03wa7gnyzax",
  "cosmoshub-4": "cosmos1tflk30mq5vgqjdly92kkhhq3raev2hnzldd74z",
  "osmosis-1": "osmo1u5v0m74mql5nzfx2yh43s2tke4mvzghrqvzsrv",
  celestia: "celestia1j2jq259d3rrc24876gwxg0ksp0lhd8gys65rxd",
  "akashnet-2": "akash1lxh0u07haj646pt9e0l2l4qc3d8htfx5u55rh8",
};

export interface MockWalletOptions {
  addresses: AddressMap;
  /** Write the reconnect hint so every load restores the wallet (default true). */
  restore?: boolean;
  /** Key name the wallet reports (the account chip shows it). */
  name?: string;
}

interface InitArgs {
  addresses: Record<string, string>;
  chains: string[];
  restore: boolean;
  name: string;
}

/** Runs in the page, before its scripts. Self-contained: it is serialised. */
function installReadOnlyKeplr({ addresses, chains, restore, name }: InitArgs): void {
  // A compressed-secp256k1-shaped placeholder: the dashboard only passes the
  // key along to a signer, and this wallet never signs.
  const pubKey = new Uint8Array(33);
  pubKey[0] = 2;
  const state = { signAttempts: 0, enabled: [] as string[] };
  const refuse = async (): Promise<never> => {
    state.signAttempts += 1;
    throw new Error("Read-only test wallet: signing is disabled");
  };
  const provider = {
    enable: async (chainIds: string | string[]) => {
      state.enabled.push(...(Array.isArray(chainIds) ? chainIds : [chainIds]));
    },
    getKey: async (chainId: string) => {
      const bech32Address = addresses[chainId];
      if (!bech32Address) throw new Error(`There is no chain info for ${chainId}`);
      return { name, algo: "secp256k1", pubKey, bech32Address, isNanoLedger: false, isKeystone: false };
    },
    experimentalSuggestChain: async () => undefined,
    signAmino: refuse,
    signDirect: refuse,
    signArbitrary: refuse,
    sendTx: refuse,
  };
  Object.defineProperty(window, "keplr", { value: provider, configurable: true, writable: true });
  Object.defineProperty(window, "__zuniaE2E", { value: state, configurable: true });
  if (!restore) return;
  try {
    window.localStorage.setItem(
      "zunia.dashboard.walletHint",
      JSON.stringify({ mode: "extension", wallet: "keplr", chainId: "safrochain-1", chains }),
    );
  } catch {
    // about:blank and sandboxed frames have no storage; the top page does.
  }
}

/** Injects the read-only wallet into every page the context opens from now on. */
export async function installMockWallet(context: BrowserContext, options: MockWalletOptions): Promise<void> {
  const args: InitArgs = {
    addresses: { ...options.addresses },
    chains: DEFAULT_FOLLOWED.filter((chainId) => chainId in options.addresses),
    restore: options.restore ?? true,
    name: options.name ?? "E2E read-only",
  };
  await context.addInitScript(installReadOnlyKeplr, args);
}

/** How many times the page asked the wallet to sign (always expected to be 0). */
export async function signAttempts(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __zuniaE2E?: { signAttempts: number } }).__zuniaE2E?.signAttempts ?? 0);
}

/**
 * Keeps Zunia Mobile's QR view from opening a real pairing session on the
 * relay (`POST /v1/connect/sessions`, production: api.zunialab.com): the
 * view then shows its "cannot reach" state, which is all a test of the
 * modal needs.
 */
export async function blockRelay(context: BrowserContext): Promise<void> {
  await context.route(/\/v1\/connect\//, (route) => route.abort("blockedbyclient"));
}
