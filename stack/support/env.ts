import { resolve } from "node:path";
import { ADDED_MNEMONIC, MNEMONIC } from "../../signing/phrases";

/** The repos under test sit next to this one, as in the Zunia-Lab workspace (WORKSPACE overrides). */
export const WORKSPACE = resolve(process.env.WORKSPACE ?? resolve(__dirname, "../../.."));

export const DAPP_PORT = Number(process.env.DAPP_PORT ?? 5175);
export const RELAY_PORT = Number(process.env.RELAY_PORT ?? 8790);
export const DAPP_URL = `http://localhost:${DAPP_PORT}`;
export const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`;

export const EXTENSION_DIR =
  process.env.ZUNIA_EXTENSION_DIR ?? resolve(WORKSPACE, "zunia-extension/.output/chrome-mv3");
export const FIREFOX_EXTENSION_DIR =
  process.env.ZUNIA_FIREFOX_EXTENSION_DIR ?? resolve(WORKSPACE, "zunia-extension/.output/firefox-mv3");
export const FIREFOX_BIN = process.env.FIREFOX_BIN ?? "/Applications/Firefox.app/Contents/MacOS/firefox";

/** Serves the pages with hostile CSPs, see csp-pages.ts. */
export const CSP_PORT = Number(process.env.CSP_PORT ?? 5176);

/** The public BIP39 test phrase ("abandon … about"). Never fund it with anything of value. */
export const TEST_PHRASE = MNEMONIC;
/** The phrase of the account a spec adds with "Add account → Restore with phrase" ("legal winner … yellow"). */
export const ADDED_PHRASE = ADDED_MNEMONIC;
export const TEST_PASSWORD = "zunia-e2e-password";
