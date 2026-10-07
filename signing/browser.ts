/**
 * The real extension in a real Chromium, for the harness: an unpacked build
 * in a throwaway profile, a wallet restored from a public test phrase through
 * the extension's own messages, and a blank local site to connect.
 *
 * Playwright's own Chromium is used: branded Google Chrome ignores
 * --load-extension since version 137. Extension pages may send every wallet
 * message (lib/sender-policy.ts), which is how approvals are answered here
 * without driving the popup.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Frame, type Page } from "@playwright/test";

/** A throwaway password for a throwaway profile. */
export const WALLET_PASSWORD = "zunia-e2e-signing-password";
export const CHAINS = ["osmosis-1", "cosmoshub-4"];

export interface ExtensionResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** One request waiting in the extension's approval queue (GET_PENDING_APPROVALS). */
export interface ApprovalItem {
  id: string;
  kind: string;
  title?: string;
  warnings?: string[];
  detail?: {
    summary?: {
      messages?: Array<{ type: string; summary: string; unknown?: boolean }>;
      warnings?: string[];
      memo?: string;
    };
    json?: string;
    preview?: string;
  };
}

export interface ExtensionSession {
  context: BrowserContext;
  extensionId: string;
  /** The build's manifest version. */
  version: string;
  /** An extension page that sends wallet messages. */
  extensionPage: Page;
  send<T = unknown>(message: { type: string; payload?: unknown }): Promise<ExtensionResponse<T>>;
  close(): Promise<void>;
}

export async function launchExtension(dir: string, options: { headless?: boolean } = {}): Promise<ExtensionSession> {
  const profile = mkdtempSync(join(tmpdir(), "zunia-signing-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: options.headless ?? process.env.HEADED !== "1",
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
    const extensionId = new URL(worker.url()).host;
    const version = (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version: string }).version;
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/onboarding.html`);
    const send = <T>(message: { type: string; payload?: unknown }) =>
      extensionPage.evaluate(
        (body) =>
          (
            globalThis as unknown as { chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } } }
          ).chrome.runtime.sendMessage(body),
        message,
      ) as Promise<ExtensionResponse<T>>;
    return {
      context,
      extensionId,
      version,
      extensionPage,
      send,
      close: async () => {
        await context.close().catch(() => undefined);
        rmSync(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await context.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

/** Restores the wallet from a phrase, as onboarding does. */
export async function importWallet(session: ExtensionSession, mnemonic: string, chains: string[] = CHAINS): Promise<void> {
  const answer = await session.send({
    type: "IMPORT_WALLET",
    payload: { mnemonic, password: WALLET_PASSWORD, name: "E2E", enabledChainIds: chains },
  });
  if (!answer.ok) throw new Error(`IMPORT_WALLET failed: ${answer.error ?? "no reason"}`);
}

/** A blank page on 127.0.0.1, where the content script injects the provider. Nothing else. */
export async function startBlankSite(): Promise<{ url: string; close(): void }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Zunia signing harness</title><h1>signing harness</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

export interface ProviderIdentity {
  version: unknown;
  extensionVersion: unknown;
  isZunia: unknown;
  features: unknown;
  featuresFrozen: boolean;
  keplrIsZunia: boolean;
}

/** What `window.zunia` says about itself (contract P1). */
export async function readProviderIdentity(page: Page): Promise<ProviderIdentity> {
  await page.waitForFunction(() => Boolean((window as unknown as { zunia?: unknown }).zunia), null, { timeout: 15_000 });
  return page.evaluate(() => {
    const zunia = (window as unknown as { zunia: Record<string, unknown>; keplr?: unknown }).zunia;
    const features = zunia.features;
    return {
      version: zunia.version,
      extensionVersion: zunia.extensionVersion,
      isZunia: zunia.isZunia,
      features: Array.isArray(features) ? [...features] : features,
      featuresFrozen: Array.isArray(features) && Object.isFrozen(features),
      keplrIsZunia: (window as unknown as { keplr?: unknown }).keplr === zunia,
    };
  });
}

/** The connect prompt the extension draws over the page, in its own frame. */
async function connectFrame(page: Page): Promise<Frame> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const frame = page.frames().find((candidate) => candidate.url().includes("/connect.html"));
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error("The extension drew no connect prompt on the page");
}

/** Calls `enable` from the page and approves it in the in-page prompt. */
export async function connectSite(page: Page, chains: string[] = CHAINS): Promise<void> {
  await page.evaluate((ids) => {
    const w = window as unknown as { zunia: { enable(ids: string[]): Promise<void> }; __enabled?: unknown };
    w.zunia.enable(ids).then(
      () => (w.__enabled = true),
      (error: unknown) => (w.__enabled = String(error)),
    );
  }, chains);
  const frame = await connectFrame(page);
  // The Connect button arms once the frame has been visibly on screen (IntersectionObserver v2).
  await page.waitForTimeout(1_200);
  await frame.getByRole("button", { name: /^Connect$/ }).click();
  await page.waitForFunction(() => (window as unknown as { __enabled?: unknown }).__enabled !== undefined, null, {
    timeout: 15_000,
  });
  const enabled = await page.evaluate(() => (window as unknown as { __enabled?: unknown }).__enabled);
  if (enabled !== true) throw new Error(`enable() failed: ${String(enabled)}`);
}

export type ProviderMethod = "signDirect" | "signAmino" | "signArbitrary";

export type PageResult =
  | { ok: true; value: unknown }
  | { ok: false; code: string | undefined; message: string };

export interface Request {
  /** The approval the request opened, as the extension queued it; null when refused first. */
  approval: ApprovalItem | null;
  result: PageResult;
}

/**
 * Sends one request from the page exactly as a dApp does, and approves it from
 * the extension when it reaches the queue. Byte fields of a direct document
 * travel as number arrays and are rebuilt in the page.
 */
export async function request(
  session: ExtensionSession,
  page: Page,
  method: ProviderMethod,
  args: unknown[],
  options: { approve?: boolean } = {},
): Promise<Request> {
  await page.evaluate(
    ({ method: name, args: list }) => {
      const w = window as unknown as {
        zunia: Record<string, (...values: unknown[]) => Promise<unknown>>;
        __result?: unknown;
      };
      const rebuilt = list.map((value) => {
        if (value && typeof value === "object" && "bodyBytes" in value) {
          const doc = value as { bodyBytes: number[]; authInfoBytes: number[] };
          return { ...doc, bodyBytes: Uint8Array.from(doc.bodyBytes), authInfoBytes: Uint8Array.from(doc.authInfoBytes) };
        }
        return value;
      });
      w.__result = undefined;
      // No named helpers in here: tsx names them with an `__name` call the page does not define.
      w.zunia[name]!(...rebuilt).then(
        (value) =>
          (w.__result = {
            ok: true,
            value: JSON.parse(JSON.stringify(value, (_key, item: unknown) => (item instanceof Uint8Array ? Array.from(item) : item))),
          }),
        (error: { code?: string; message?: string }) => (w.__result = { ok: false, code: error?.code, message: String(error?.message ?? error) }),
      );
    },
    { method, args },
  );
  let approval: ApprovalItem | null = null;
  for (let attempt = 0; attempt < 100 && !approval; attempt++) {
    await page.waitForTimeout(150);
    if (await page.evaluate(() => (window as unknown as { __result?: unknown }).__result !== undefined)) break;
    const queue = await session.send<ApprovalItem[]>({ type: "GET_PENDING_APPROVALS" });
    approval = (queue.data ?? []).find((item) => item.kind === method) ?? null;
  }
  if (approval) {
    const answer =
      options.approve === false
        ? await session.send({ type: "REJECT_APPROVAL", payload: { id: approval.id } })
        : await session.send({
            type: "RESOLVE_APPROVAL",
            payload: { id: approval.id, result: { approved: true }, password: WALLET_PASSWORD },
          });
    if (!answer.ok) throw new Error(`Answering the approval failed: ${answer.error ?? "no reason"}`);
  }
  await page.waitForFunction(() => (window as unknown as { __result?: unknown }).__result !== undefined, null, {
    timeout: 30_000,
  });
  const result = (await page.evaluate(() => (window as unknown as { __result?: unknown }).__result)) as PageResult;
  return { approval, result };
}

/** Waits until the page's `getKey` answers `address` (after the wallet switched accounts). */
export async function waitForActiveAddress(page: Page, chainId: string, address: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await page
      .evaluate((id) => (window as unknown as { zunia: { getKey(id: string): Promise<{ bech32Address: string }> } }).zunia.getKey(id), chainId)
      .then((key) => key.bech32Address)
      .catch(() => "");
    if (current === address) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`The page never saw ${address} as the active account on ${chainId}`);
}
