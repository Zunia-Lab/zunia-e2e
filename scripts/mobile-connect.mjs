#!/usr/bin/env node
// Zunia Connect v2 end to end on a phone: a local relay, a site built on
// @zunialab/sdk-web, and the Maestro flow that pairs zunia-mobile with it.
// The site checks the sign-in it gets back with verifySignIn.
//
//   node scripts/mobile-connect.mjs                   # iOS simulator
//   PLATFORM=android node scripts/mobile-connect.mjs  # Android emulator, through adb reverse
//
// Needs Maestro on PATH (or MAESTRO_BIN), a booted simulator or emulator
// with a debug build of zunia-mobile installed, zunia-backend with its
// dependencies next to this repo, and a built zunia-sdk next to it too
// (`pnpm build` there), or ZUNIA_SDK_DIR pointing at one.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const sdkRoot = process.env.ZUNIA_SDK_DIR ?? fileURLToPath(new URL("../../zunia-sdk/", import.meta.url));
const sdk = (name) => import(pathToFileURL(join(sdkRoot, "packages", name, "dist/index.js")).href);
const { createNonce, verifySignIn } = await sdk("core");
const { createZuniaSession } = await sdk("web");

const ANDROID = process.env.PLATFORM === "android";
const APP_ID = ANDROID ? "com.zuniawallet.zunia_mobile" : "com.zuniawallet.zuniaMobile";
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 8788);
const STATE_PORT = Number(process.env.STATE_PORT ?? 8799);
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const SITE = process.env.SITE_ORIGIN ?? "http://localhost:5173";
const HOST = new URL(SITE).host;
const CHAIN = "cosmoshub-4";
const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const backendRoot = fileURLToPath(new URL("../../zunia-backend/", import.meta.url));

const state = { code: null, host: HOST, signedIn: false, error: null };
const cleanups = [];

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
}

async function startRelay() {
  // Node directly, not `pnpm exec`, so SIGTERM reaches the server.
  const relay = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: backendRoot,
    env: { ...process.env, PORT: String(RELAY_PORT), DATABASE_URL: "" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  cleanups.push(async () => {
    if (relay.exitCode !== null || relay.signalCode !== null) return;
    const exited = new Promise((resolve) => relay.once("exit", resolve));
    relay.kill();
    await exited;
  });
  await waitFor(
    () => fetch(`${RELAY}/health`).then((r) => r.ok, () => false),
    30_000,
    "the relay",
  );
}

function startStateServer() {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(state));
  });
  server.listen(STATE_PORT, "127.0.0.1");
  cleanups.push(() => server.close());
}

/** Session creation from a page carries its Origin; this does the same outside a browser. */
function fetchAsSite(input, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", SITE);
  return fetch(input, { ...init, headers });
}

async function main() {
  await startRelay();
  startStateServer();
  // The pairing link names 127.0.0.1, which on an emulator is the emulator itself.
  if (ANDROID && (await run("adb", ["reverse", `tcp:${RELAY_PORT}`, `tcp:${RELAY_PORT}`])) !== 0) {
    throw new Error("adb reverse failed; is the emulator running?");
  }

  const session = createZuniaSession({ nativeWs: { fetch: fetchAsSite } });
  cleanups.push(() => session.disconnect());
  session.subscribe(() => {
    if (session.verificationCode) state.code = session.verificationCode;
  });

  const connected = session.connect({
    prefer: "native-ws",
    apiBase: RELAY,
    chains: [CHAIN],
    metadata: { name: "Zunia E2E", url: SITE },
    storage: null,
    timeoutMs: 9 * 60_000,
  });
  const signedIn = connected.then(async () => {
    const nonce = createNonce();
    const result = await session.signIn({
      nonce,
      domain: HOST,
      uri: SITE,
      statement: "Sign in to the Zunia end-to-end test.",
    });
    const verified = verifySignIn({
      message: result.message,
      signature: result.signature,
      domain: HOST,
      nonce,
      chainId: CHAIN,
      address: result.address,
    });
    state.signedIn = true;
    console.log(`Signed in as ${verified.address} on ${verified.chainId}`);
  });
  signedIn.catch((error) => {
    state.error = error instanceof Error ? error.message : String(error);
  });

  await waitFor(() => Boolean(session.pairing), 10_000, "the pairing link");
  const uri = session.pairing.uri;
  console.log(`Pairing link: ${uri}`);

  const exitCode = await run(
    process.env.MAESTRO_BIN ?? "maestro",
    [
      "test",
      "maestro/connect.yaml",
      "-e",
      `APP_ID=${APP_ID}`,
      "-e",
      `PAIRING_URI=${uri}`,
      "-e",
      `STATE_URL=http://127.0.0.1:${STATE_PORT}/`,
    ],
    { cwd: e2eRoot },
  );
  if (exitCode !== 0) throw new Error(`The Maestro flow failed (exit ${exitCode})`);

  await waitFor(() => state.signedIn || state.error !== null, 30_000, "the sign-in");
  if (state.error) throw new Error(`The site refused the result: ${state.error}`);
  console.log("Paired, connected, signed in, and the site verified the signature.");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // Best effort.
    }
  }
}
