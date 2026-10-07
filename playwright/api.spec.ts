/**
 * API contract smoke: the routes the pages are built on answer in the shape
 * the pages read (zunia-dashboard lib/token/wire.ts, lib/chain/types.ts) and
 * refuse bad input with a 400 that says why.
 *
 * Shapes, never values: prices, APRs and balances move every block. Live
 * reads are retried for up to a minute, so a public node's hiccup is ridden
 * out rather than reported; one that lasts is a real outage and fails.
 */

import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "./support/dashboard";
import { RETAIL_WALLET } from "./support/mock-wallet";

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNullableNumber = (value: unknown) => value === null || isNumber(value);

/** GET `path` until it answers 200 (live upstreams), then hands back the JSON. */
async function liveJson(request: APIRequestContext, path: string): Promise<{ response: APIResponse; body: Record<string, unknown> }> {
  let last: { response: APIResponse; body: Record<string, unknown> } | null = null;
  await expect(async () => {
    const response = await request.get(path, { timeout: 45_000 });
    expect(response.headers()["content-type"]).toMatch(/application\/json/);
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status(), `${path}: ${JSON.stringify(body).slice(0, 200)}`).toBe(200);
    last = { response, body };
  }).toPass({ timeout: 60_000, intervals: [2_000, 5_000, 10_000] });
  return last as unknown as { response: APIResponse; body: Record<string, unknown> };
}

/** A refused request: 400 with a machine code and a sentence, never an upstream's words. */
async function expectBadRequest(request: APIRequestContext, path: string, code?: string | RegExp): Promise<void> {
  const response = await request.get(path);
  expect(response.status(), path).toBe(400);
  const body = (await response.json()) as { error?: unknown; message?: unknown };
  expect(typeof body.error, `${path}: error code`).toBe("string");
  expect(typeof body.message, `${path}: message`).toBe("string");
  if (typeof code === "string") expect(body.error).toBe(code);
  else if (code) expect(body.error).toMatch(code);
}

test.describe("/api/health", () => {
  test("answers 200 with its checks", async ({ request }) => {
    // 503 while Safrochain's public node does not answer: retried (the
    // checks are cached 10 s) until a minute of it is a real outage.
    const { response, body: raw } = await liveJson(request, "/api/health");
    const body = raw as Record<string, any>;
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(body).toMatchObject({ ok: true, service: "zunia-dashboard", degraded: expect.any(Boolean) });
    expect(typeof body.version).toBe("string");
    expect(isNumber(body.uptimeSec)).toBe(true);
    expect(isNumber(body.updatedAt)).toBe(true);
    expect(body.checks.lcd).toMatchObject({ ok: true, chainId: "safrochain-1" });
    expect(isNumber(body.checks.lcd.height)).toBe(true);
    expect(typeof body.checks.numia.ok).toBe("boolean");
  });

  test("?live=1 answers from the process alone", async ({ request }) => {
    const response = await request.get("/api/health?live=1");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, service: "zunia-dashboard" });
    expect(body).not.toHaveProperty("checks");
  });
});

test.describe("/api/markets", () => {
  test("lists priced assets with their source", async ({ request }) => {
    const { response, body } = await liveJson(request, "/api/markets");
    expect(response.headers()["cache-control"]).toMatch(/\bpublic\b/);
    expect(body.currency).toBe("usd");
    expect(isNumber(body.updatedAt)).toBe(true);
    const sources = body.sources as Array<Record<string, unknown>>;
    expect(Array.isArray(sources) && sources.length > 0).toBe(true);
    for (const source of sources) {
      expect(typeof source.id).toBe("string");
      expect(typeof source.label).toBe("string");
      expect(typeof source.ok).toBe("boolean");
    }
    const assets = body.assets as Array<Record<string, unknown>>;
    expect(Array.isArray(assets)).toBe(true);
    expect(assets.length).toBeGreaterThan(10);
    const keys = new Set<string>();
    for (const asset of assets) {
      expect(typeof asset.key).toBe("string");
      expect(typeof asset.symbol).toBe("string");
      expect(typeof asset.name).toBe("string");
      expect(isNumber(asset.price) && (asset.price as number) > 0, `${asset.symbol} has a price`).toBe(true);
      for (const field of ["change24h", "change7d", "volume24h", "liquidity", "marketCap"]) {
        expect(isNullableNumber(asset[field]), `${asset.symbol}.${field}`).toBe(true);
      }
      expect(asset.sparkline7d === null || (Array.isArray(asset.sparkline7d) && asset.sparkline7d.every(isNumber))).toBe(true);
      expect(typeof asset.tradable).toBe("boolean");
      expect(typeof asset.verified).toBe("boolean");
      keys.add(asset.key as string);
    }
    expect(keys.size, "one row per asset").toBe(assets.length);
  });

  test("answers in the currency asked for", async ({ request }) => {
    const { body } = await liveJson(request, "/api/markets?currency=eur");
    // A missing FX rate falls back to USD, and says so.
    if (body.currencyFallback) expect(body.currency).toBe("usd");
    else expect(body.currency).toBe("eur");
  });

  test("refuses an unknown currency", async ({ request }) => {
    await expectBadRequest(request, "/api/markets?currency=doge", "currency_invalid");
  });
});

test.describe("/api/chains/stats", () => {
  test("returns the chains asked for, in order, and names the unknown ones", async ({ request }) => {
    test.setTimeout(150_000);
    const { response, body } = await liveJson(request, "/api/chains/stats?chains=cosmoshub-4,osmosis-1,not-a-chain");
    expect(response.headers()["cache-control"]).toMatch(/\bpublic\b/);
    expect(body.currency).toBe("usd");
    expect(isNumber(body.updatedAt)).toBe(true);
    expect(body.unknown).toEqual(["not-a-chain"]);
    const chains = body.chains as Array<Record<string, any>>;
    // A chain still loading is listed in `errors` instead (200, "Timed out").
    const errors = (body.errors ?? []) as Array<{ chainId?: string }>;
    const listed = chains.map((chain) => chain.chainId);
    const expected = ["cosmoshub-4", "osmosis-1"].filter((id) => listed.includes(id) || !errors.some((e) => e.chainId === id));
    expect(listed).toEqual(expected);
    for (const chain of chains) {
      expect(typeof chain.chainName).toBe("string");
      expect(["mainnet", "testnet"]).toContain(chain.network);
      expect(typeof chain.nativeSymbol).toBe("string");
      expect(typeof chain.nativeDenom).toBe("string");
      expect(typeof chain.apr).toBe("object");
      expect(isNullableNumber(chain.apr.actual)).toBe(true);
      expect(isNullableNumber(chain.apr.naive)).toBe(true);
      for (const field of ["realYield", "bondedRatio", "unbondingDays", "activeValidators", "nakamoto", "top10Share", "latestHeight", "blockTimeSec"]) {
        expect(isNullableNumber(chain[field]), `${chain.chainId}.${field}`).toBe(true);
      }
      expect(chain.price === null || isNumber(chain.price.price)).toBe(true);
      expect(chain.halted === null || typeof chain.halted === "boolean").toBe(true);
    }
  });

  test("requires chains", async ({ request }) => {
    await expectBadRequest(request, "/api/chains/stats", "chains_required");
    await expectBadRequest(request, "/api/chains/stats?chains=cosmoshub-4&currency=doge", "currency_invalid");
  });
});

test.describe("/api/portfolio", () => {
  const hub = RETAIL_WALLET["cosmoshub-4"] as string;
  const osmo = RETAIL_WALLET["osmosis-1"] as string;
  const cases: Array<{ name: string; query: string; code?: string | RegExp }> = [
    { name: "no accounts", query: "", code: "accounts_required" },
    { name: "an empty list", query: "accounts=,,", code: "accounts_required" },
    { name: "an entry without a chain", query: `accounts=${hub}`, code: "accounts_invalid" },
    { name: "an unknown chain", query: `accounts=not-a-chain:${hub}`, code: "chainId_unknown" },
    { name: "another chain's address", query: `accounts=cosmoshub-4:${osmo}` },
    { name: "a malformed address", query: "accounts=cosmoshub-4:cosmos1notbech32" },
    // Two different entries for one chain (identical ones are merged).
    { name: "the same chain twice", query: `accounts=cosmoshub-4:${hub},cosmoshub-4:${hub}x`, code: "accounts_duplicate_chain" },
    { name: "an unknown currency", query: `accounts=cosmoshub-4:${hub}&currency=doge`, code: "currency_invalid" },
  ];
  for (const { name, query, code } of cases) {
    test(`400 on ${name}`, async ({ request }) => {
      await expectBadRequest(request, `/api/portfolio${query ? `?${query}` : ""}`, code);
    });
  }

  test("400 on more than 32 accounts", async ({ request }) => {
    const many = Array.from({ length: 33 }, (_, i) => `chain-${i}:${hub}`).join(",");
    await expectBadRequest(request, `/api/portfolio?accounts=${encodeURIComponent(many)}`, "accounts_too_many");
  });

  test("reads a public account, privately", async ({ request }) => {
    test.setTimeout(150_000);
    const accounts = ["cosmoshub-4", "osmosis-1"].map((chainId) => `${chainId}:${RETAIL_WALLET[chainId]}`).join(",");
    const { response, body } = await liveJson(request, `/api/portfolio?accounts=${encodeURIComponent(accounts)}`);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(body.currency).toBe("usd");
    const totals = body.totals as Record<string, unknown>;
    expect(isNullableNumber(totals.value)).toBe(true);
    for (const field of ["liquid", "staked", "rewards", "unbonding", "pricedValue", "unpricedAssetCount", "assetCount", "chainCount"]) {
      expect(isNumber(totals[field]), `totals.${field}`).toBe(true);
    }
    const chains = body.chains as Array<Record<string, unknown>>;
    expect(chains.map((chain) => chain.chainId).sort()).toEqual(["cosmoshub-4", "osmosis-1"]);
    for (const chain of chains) {
      expect(["ok", "error"]).toContain(chain.status);
      expect(typeof chain.address).toBe("string");
      expect(isNullableNumber(chain.value)).toBe(true);
      expect(isNumber(chain.assetCount)).toBe(true);
    }
    expect(Array.isArray(body.assets)).toBe(true);
  });
});
