import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { DAPP_URL, RELAY_PORT, RELAY_URL } from "./support/env";
import { bytesToBase64Url, createNonce, createZuniaSession, parsePairingUri, verifySignIn } from "./support/sdk";
import { TcpProxy } from "./support/tcp-proxy";
import { TestWallet } from "./support/test-wallet";

/**
 * zunia.connect.v2 against the real relay (zunia-backend): the SDK's QR
 * transport on the site side, a simulated phone on the other.
 */

const CHAIN = "cosmoshub-4";
const HOST = new URL(DAPP_URL).host;

/** A page sends its Origin when it creates the session; Node has to add it. */
function fetchAsSite(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", DAPP_URL);
  return fetch(input, { ...init, headers });
}

async function pair(options: { wsBase?: string } = {}) {
  const session = createZuniaSession({ nativeWs: { fetch: fetchAsSite } });
  const wallet = new TestWallet();
  const connected = session.connect({
    prefer: "native-ws",
    apiBase: RELAY_URL,
    wsBase: options.wsBase,
    chains: [CHAIN],
    metadata: { name: "Zunia e2e", url: DAPP_URL },
    storage: null,
  });
  await expect.poll(() => session.pairing?.uri).toBeTruthy();
  const uri = session.pairing!.uri;
  await wallet.scan(uri);
  await wallet.approve();
  await connected;
  return { session, wallet, uri };
}

async function signIn(session: ReturnType<typeof createZuniaSession>, wallet: TestWallet) {
  const nonce = createNonce();
  const signing = session.signIn({ nonce, domain: HOST, uri: DAPP_URL, chainId: CHAIN });
  await wallet.answerSignArbitrary();
  const result = await signing;
  return verifySignIn({
    message: result.message,
    signature: result.signature,
    domain: HOST,
    nonce,
    chainId: CHAIN,
    address: wallet.address,
  });
}

test.describe("Zunia Connect relay", () => {
  test("pairs with the same code on both sides and the origin the relay saw", async () => {
    const { session, wallet } = await pair();

    expect(session.verificationCode).toMatch(/^\d{6}$/);
    expect(session.verificationCode).toBe(wallet.verificationCode);
    expect(wallet.welcome?.verifiedOrigin).toBe(DAPP_URL);
    expect(session.status).toBe("connected");
    expect(session.accounts.map((account) => account.address)).toEqual([wallet.address]);

    // The relay only ever carried ciphertext: nothing the site sent reads in clear.
    expect(wallet.frames.some((frame) => frame.t === "msg")).toBe(true);
    const seen = JSON.stringify(wallet.frames);
    expect(seen).not.toContain(CHAIN);
    expect(seen).not.toContain("connect_request");

    await session.disconnect();
  });

  test("signs in through the relay, and the site verifies the signature", async () => {
    const { session, wallet } = await pair();
    const verified = await signIn(session, wallet);
    expect(verified.address).toBe(wallet.address);
    expect(verified.chainId).toBe(CHAIN);
    await session.disconnect();
  });

  test("a request made while the site is offline goes through after it reconnects", async () => {
    const proxy = new TcpProxy({ host: "127.0.0.1", port: RELAY_PORT });
    await proxy.start();
    try {
      const { session, wallet } = await pair({ wsBase: `ws://127.0.0.1:${proxy.port}` });
      expect(proxy.cut("role=dapp")).toBe(1);
      const verified = await signIn(session, wallet);
      expect(verified.address).toBe(wallet.address);
      await expect.poll(() => session.status).toBe("connected");
      await session.disconnect();
    } finally {
      await proxy.stop();
    }
  });

  test("the phone comes back with its resume token and gets what it missed", async () => {
    const { session, wallet } = await pair();
    wallet.goOffline();
    const nonce = createNonce();
    const signing = session.signIn({ nonce, domain: HOST, uri: DAPP_URL, chainId: CHAIN });
    // Give the relay time to hold the request for the absent phone.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await wallet.reconnect();
    // A resumed socket gets no new resume token: the first one stays valid.
    expect(wallet.welcome?.resumeToken).toBeUndefined();
    await wallet.answerSignArbitrary();
    const result = await signing;
    expect(verifySignIn({ message: result.message, signature: result.signature, domain: HOST, nonce }).address).toBe(
      wallet.address,
    );
    await session.disconnect();
  });

  test("refuses a wrong secret and a second use of the pairing code", async () => {
    const { session, wallet, uri } = await pair();
    const link = parsePairingUri(uri)!;

    expect(await TestWallet.refused(wallet.joinUrl, bytesToBase64Url(randomBytes(32)))).toBe(4401);
    expect(await TestWallet.refused(wallet.joinUrl, link.joinToken)).toBe(4401);
    // The session survives both attempts.
    expect(session.status).toBe("connected");
    expect((await signIn(session, wallet)).address).toBe(wallet.address);

    await session.disconnect();
  });

  test("the phone ending the session reaches the site", async () => {
    const { session, wallet } = await pair();
    const ended = new Promise<string>((resolve) => session.on("disconnect", resolve));
    wallet.end();
    await ended;
    await expect.poll(() => session.status).toBe("disconnected");
  });

  test("the site ending the session reaches the phone", async () => {
    const { session, wallet } = await pair();
    await session.disconnect();
    await expect.poll(() => wallet.closeCode).toBe(4001);
    expect(wallet.frames.at(-1)).toMatchObject({ t: "closed" });
  });
});
