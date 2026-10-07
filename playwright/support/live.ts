/**
 * Identifiers read from the dashboard's own API, for pages whose URL names
 * live data (a validator, a proposal, an asset, a transaction). Each returns
 * null when the API cannot answer right now, and the caller skips: the page
 * cannot be tested without something real to show, and the API's own health
 * is api.spec.ts's business.
 */

import type { APIRequestContext } from "@playwright/test";
import type { AddressMap } from "./mock-wallet";

async function json<T>(request: APIRequestContext, path: string): Promise<T | null> {
  try {
    const res = await request.get(path, { timeout: 30_000 });
    return res.ok() ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** The largest validator of a chain (operator address). */
export async function firstValidator(request: APIRequestContext, chainId: string): Promise<string | null> {
  const body = await json<{ validators?: Array<{ operatorAddress?: unknown }> }>(
    request,
    `/api/validators?chainId=${encodeURIComponent(chainId)}`,
  );
  const address = body?.validators?.[0]?.operatorAddress;
  return typeof address === "string" ? address : null;
}

/** A recent proposal id of a chain. */
export async function firstProposal(request: APIRequestContext, chainId: string): Promise<string | null> {
  const body = await json<{ proposals?: Array<{ id?: unknown; chainId?: unknown }> }>(
    request,
    `/api/governance?chains=${encodeURIComponent(chainId)}&status=all`,
  );
  const proposal = body?.proposals?.find((row) => row.chainId === chainId && typeof row.id === "string");
  return typeof proposal?.id === "string" ? proposal.id : null;
}

/** The most liquid listed asset's identity key (`/assets/<key>`). */
export async function firstMarketAsset(request: APIRequestContext): Promise<string | null> {
  const body = await json<{ assets?: Array<{ key?: unknown }> }>(request, "/api/markets");
  const key = body?.assets?.[0]?.key;
  return typeof key === "string" ? key : null;
}

/** The newest transaction of some accounts: its hash and chain. */
export async function latestTransaction(
  request: APIRequestContext,
  wallet: AddressMap,
): Promise<{ hash: string; chainId: string } | null> {
  const accounts = Object.entries(wallet)
    .map(([chainId, address]) => `${chainId}:${address}`)
    .join(",");
  const body = await json<{ items?: Array<{ hash?: unknown; chainId?: unknown }> }>(
    request,
    `/api/activity?accounts=${encodeURIComponent(accounts)}&limit=5`,
  );
  const item = body?.items?.find((row) => typeof row.hash === "string" && typeof row.chainId === "string");
  return item ? { hash: item.hash as string, chainId: item.chainId as string } : null;
}
