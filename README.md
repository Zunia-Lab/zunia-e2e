# zunia-e2e

End-to-end tests for Zunia. They run the browser extension, the JS SDK, the Connect relay and
the phone wallet together, from the checkouts next to this repo, so they test the code as it
is now rather than a release. The signing harness checks every signature the wallets make
the way a chain would check it.

## Layout

```
signing/      The signing harness: reference cases, the chain's check offline, Tiers 0, 1 and 2a
stack/        Playwright: the extension and the SDK against the relay
maestro/      Maestro: the phone wallet pairing with a site
scripts/      Drivers that start what a suite needs, then run it
playwright/   Playwright: the dashboard (app.zunialab.com) against a running deployment
```

## Before you start

The stack, signing and phone suites expect the other repositories next to this one:

```
zunia/
  zunia-e2e/
  zunia-sdk/         pnpm install && pnpm build
  zunia-backend/     pnpm install
  zunia-core/        pnpm build:wasm, for packages/npm (the kernel)
  zunia-extension/   pnpm build:chrome && pnpm build:firefox (the kernel comes from zunia-core)
  zunia-dashboard/   pnpm install, for the signing harness's Tier 2a
  zunia-mobile/      a debug build, for the phone flow only
```

The Firefox spec also needs a stock Firefox, found in `/Applications` or through `FIREFOX_BIN`.
Then, in this repo:

```bash
pnpm install
pnpm exec playwright install chromium
```

## Signing (signing/)

A chain does not trust a wallet's word: it rebuilds the bytes that were signed and verifies the
signature over them. The harness does the same, offline, and tells which build signs what the
chain accepts. Every key comes from the public BIP39 test phrases ("abandon … about" for the
first account, "legal winner … yellow" for an account added with its own phrase), and nothing
is ever broadcast.

```bash
pnpm test:signing                      # self-test, anchor, Tier 0 and the extension's own flows
pnpm test:signing:extension            # Tier 1: a real extension build, about 20 s
pnpm test:signing:dashboard            # Tier 2a: the dashboard's sign flow, four wallets
```

- `cases.ts` builds 24 reference cases with the reference libraries (osmojs 16.15, cosmjs-types
  0.9, CosmJS 0.33.1), never by hand: sends (a memo with `& < >`, one with U+2028, a 32-byte
  recipient), IBC transfers (timestamp only, with a height, with a packet-forward memo, with an
  ibc-hooks memo), staking, votes (gov v1beta1 and v1), Osmosis swaps (exact-in and exact-out,
  single and split), contract calls (XCS, recovery, CW721 with `&`), an authz grant, and a send
  from an added account. Each case says what a correct prompt shows (the F1 sentence), what
  the approval's JSON must hold (a contract body, a packet memo) and why a legacy build fails it.
- `amino-json.ts` is the A1 rule: keys sorted, compact, `& < >` and U+2028, U+2029 escaped as
  Go's `json.Marshal` does. `go/escape.go` prints what Go writes; the self-test compares when a
  Go toolchain is installed.
- `oracle.ts` (`verifyTxRaw`) rebuilds the sign bytes from a TxRaw as the chain does: the
  SignDoc for direct, the amino document rebuilt from the protobuf messages for amino.
- `selftest.ts` checks the oracle: every CosmJS-signed case verifies, a flipped bit does not, a
  signature over unescaped bytes fails exactly when the document has something to escape.
- `anchor.ts` verifies 5 real cosmoshub-4 amino signatures (`fixtures/chain-verified-amino.json`)
  through the oracle, and shows the same signatures fail over the shapes Zunia 0.1.4 writes.
- `tier0-kernel.ts`: the kernel (KERNEL) decodes and signs every case; its signatures must equal
  CosmJS's byte for byte, and from kernel 0.1.1 its payload v2 must name the type, recipient,
  contract body, packet memo and fee.
- `own-flows.ts`: the extension's own Send, Earn and Governance transactions (EXT_SRC
  `lib/amino-tx.ts`) through the oracle.
- `tier1-extension.ts`: the unpacked build (EXT_DIR) in a throwaway Chromium profile signs every
  case in both modes through `window.zunia`, approved from its own queue, then an account added
  with its own phrase signs too. It also checks the prompt sentences, the approval JSON, the
  refusal that names the type, and the provider identity (`extensionVersion`, `isZunia`,
  `features`).
- `tier2-dashboard.ts`: the dashboard's real `signAndBroadcast` (DASHBOARD_SRC) with Keplr,
  Zunia 0.1.4, Zunia 0.1.5 and Zunia Mobile stand-ins; the bytes it would broadcast go through
  the oracle. Keplr, Mobile and 0.1.4 are compared by diff with the table recorded on the
  deployed dashboard (`baselines/tier2-dashboard-a8cab18.json`).
- `probe.ts` prints what a build says about itself and which documents it prompts for, rejecting
  every prompt: `EXT_DIR=… pnpm exec tsx signing/probe.ts`.

Paths come from `WORKSPACE`, `EXT_SRC` (the extension checkout), `EXT_DIR` (an unpacked build,
default `EXT_SRC/.output/chrome-mv3`), `KERNEL` (default `zunia-core/packages/npm/node/index.mjs`)
and `DASHBOARD_SRC`. `ONLY=<regex>` keeps some cases, `HEADED=1` shows the browser.

Every tier is judged as the 0.1.5 release unless `SIGNING_EXPECT` names a legacy build. On a
legacy build, `SIGNING_EXPECT=0.1.4` (or `0.1.3`) must pass: the harness then reproduces the known
failures exactly, which is how it shows it sees them. On the published builds:

```bash
SIGNING_EXPECT=0.1.4 EXT_DIR=…/ext-014 pnpm test:signing:extension   # 25/32 on the 2026-10-07 matrix
SIGNING_EXPECT=0.1.3 EXT_DIR=…/ext-013 pnpm test:signing:extension   # 23/32
```

## Extension and relay (stack/)

```bash
pnpm test:stack                         # all three specs
pnpm test:stack stack/relay.spec.ts     # the relay only, no extension build needed
```

Playwright starts the SDK's example dApp on port 5175 and a relay on port 8790, in memory with
no database, or reuses them if they already run.

- `stack/relay.spec.ts` connects the SDK's QR transport to the real relay and to a simulated
  phone wallet (`stack/support/test-wallet.ts`) that speaks `zunia.connect.v2`. Both sides
  show the same 6-digit code, the phone is told the site's origin as the relay saw it, and the
  relay only carries ciphertext. The spec also verifies a sign-in, sends a request while the
  site is offline and sees it answered after the reconnect, resumes the phone with its resume
  token, checks that a wrong secret and a reused QR token are refused, and ends the session
  from either side.
- `stack/extension.spec.ts` loads `zunia-extension/.output/chrome-mv3`, the build Chrome, Edge
  and Brave install, into Chromium. It checks that the WASM signing kernel loads, that opening
  the wallet restarts its auto-lock timer, and that the provider reaches pages whose
  Content-Security-Policy blocks injected scripts. It then restores a test wallet, connects
  from the example dApp, checks what the provider says about itself (`version`,
  `extensionVersion`, `isZunia`, `features`), signs in and has the example's server verify it,
  signs an Amino transaction whose memo holds `& < >` and a Direct contract call on a 32-byte
  contract, has the SDK's `getOfflineSignerFor` sign a contract call through the extension
  (when the example exposes `window.zuniaExample`), checks that an authz grant is refused with
  its type named, adds an account with its own phrase and signs in and signs from it, then
  revokes the site and checks that the page hears every change live. Every signature is checked
  over the bytes the chain rebuilds.
- `stack/firefox.spec.ts` runs the main checks on `.output/firefox-mv3` in a stock Firefox,
  the provider identity and the memo with `& < >` included.
  Playwright's Firefox cannot load extensions, so puppeteer-core drives Firefox over WebDriver
  BiDi. Firefox has no IntersectionObserver v2, so the extension does not draw its in-page
  connect prompt there, and the spec approves the connect request from the toolbar popup's
  queue. Firefox unloads an idle background page after 30 seconds; the spec shortens that to
  5, so the extension also comes back from it between steps, and a last check makes sure the
  wallet is still unlocked afterwards. The spec skips itself when Firefox is missing.

The test wallet uses the public BIP39 test phrase "abandon … about", and the added account
"legal winner … yellow". Never send funds to them.

The provider identity, the escaped memo, the 32-byte contract call, the named refusal and the
added account's signatures are what Zunia 0.1.5 fixed, so a 0.1.4 build fails those tests (the
suite stops at the first, as its tests share one wallet). `ZUNIA_EXTENSION_DIR` and
`ZUNIA_FIREFOX_EXTENSION_DIR` point the specs at other builds. A Firefox that is applying an
update refuses to start under puppeteer; a copy of the app elsewhere, named in `FIREFOX_BIN`,
starts clean.

Playwright cannot open the extension's toolbar popup, so the tests answer approvals from
`popup.html?approve=1` in a tab. That is the same queue the extension opens in a window when
it cannot open the popup.

## Phone (maestro/)

`maestro/connect.yaml` restores a test wallet in zunia-mobile, opens a site's pairing link as a
scan would, checks the approval sheet (verified origin, same code as the site), connects and
signs in. `scripts/mobile-connect.mjs` starts a relay on port 8788, creates the site's session
with `@zunialab/sdk-web`, runs the flow with the pairing link, then checks the sign-in with
`verifySignIn`.

Install [Maestro](https://maestro.mobile.dev), or point `MAESTRO_BIN` at it, and use a debug
build of the app: only debug builds trust a relay on this machine.

```bash
# iOS Simulator. The kernel ships an arm64 simulator slice only.
cd ../zunia-mobile
FLUTTER_XCODE_ARCHS=arm64 FLUTTER_XCODE_ONLY_ACTIVE_ARCH=YES flutter build ios --simulator --debug
xcrun simctl install booted build/ios/iphonesimulator/Runner.app
cd ../zunia-e2e && pnpm test:mobile:connect

# Android emulator. The driver maps the relay port with adb reverse.
cd ../zunia-mobile
flutter build apk --debug && adb install -r build/app/outputs/flutter-apk/app-debug.apk
cd ../zunia-e2e && PLATFORM=android pnpm test:mobile:connect
```

The flow passes on an iOS 26 simulator. The Android path has not been run yet. Prefer a fresh
simulator: system prompts, such as an Apple account check, cover the app, and the flow only
dismisses the common ones.

## Safari, and what stays manual

Neither Playwright nor puppeteer can load an extension into Safari. Run the manual checklist
in [zunia-extension/docs/browsers.md](https://github.com/Zunia-Lab/zunia-extension/blob/main/docs/browsers.md)
on macOS and iOS before a store submission. The same checklist covers what the specs do not
reach in Chrome and Firefox either, such as lock and unlock, and revoking a single chain.

## Dashboard (playwright/)

```bash
E2E_BASE_URL=http://127.0.0.1:3000 pnpm test:dashboard   # zunia-dashboard's `pnpm dev`, a preview or production
```

The suite reads live chain data through the dashboard's API and asserts shapes, never values.
Every test skips itself when nothing answers at `E2E_BASE_URL` (default
`http://127.0.0.1:3000`); `E2E_REQUIRE_DASHBOARD=1` makes that a failure. `E2E_WORKERS` sets
the parallelism (4 by default, 2 in CI).

- `smoke.spec.ts`: every public page answers 200 with its title, one h1, no console error and
  no sideways scroll at 390 px, detail pages included (a validator, a proposal, an asset and a
  transaction read from the API first); wallet pages show the connect panel without a wallet;
  unknown URLs are 404s.
- `wallet.spec.ts`: with a wallet. Overview's net worth, scope switching (rail, popover, the
  `0` shortcut), privacy mode, the command palette (Meta+K), the notifications popover, theme
  and currency, Disconnect, connecting Keplr from a page's connect panel, and every wallet page
  at 390 px with its data on screen.
- `headers.spec.ts`: anti-framing and the other security headers, `private, no-store` on
  address-keyed API calls, the service worker's cache rules, robots meta and canonical URLs,
  robots.txt, and a sitemap whose every entry answers 200 and is indexable.
- `api.spec.ts`: `/api/health`, `/api/markets`, `/api/chains/stats` and `/api/portfolio`
  answer in the shape the pages read, and refuse bad input with a 400.
- `regressions.spec.ts`: the decisions of the v2 audit. The Staking Network select is clickable
  and leads to the validator picker, `/mobile` is a 308 to the Connect wallet modal's Zunia
  Mobile view, the modal offers Zunia Mobile (no page, no nav entry, no "pair" button),
  `/notifications` only lists (preferences live in Settings), and Activity shows at most ten
  rows before "Load more".

The wallet is a read-only stand-in for Keplr (`support/mock-wallet.ts`), injected before the
page loads: it shares public addresses of real accounts and every signing call throws, so no
test can sign or broadcast. Zunia Mobile's QR view is kept from opening a real pairing session
on the relay.

### Signing from the dashboard (playwright/signing.spec.ts)

The dashboard's own pages sign with a wallet in the browser, and every transaction they would
broadcast goes through the oracle. It runs only with `E2E_SIGNING=1`, and refuses to start
unless `E2E_BASE_URL` is on localhost or 127.0.0.1:

```bash
E2E_SIGNING=1 E2E_BASE_URL=http://127.0.0.1:3000 EXT_DIR=…/chrome-mv3 EXT_DIR_014=…/ext-014 \
  pnpm exec playwright test playwright/signing.spec.ts
```

- Wallets: a Keplr-shaped wallet that signs with CosmJS from the public test phrase
  (`support/keplr-signing-mock.ts`, bundled with esbuild and injected before the page loads),
  the extension build in `EXT_DIR` and, for the legacy policy, a 0.1.4 build in `EXT_DIR_014`.
- Routes fail closed: `/api/account`, `/api/tx/simulate` and `/api/tx/<hash>` are answered by
  the spec, `POST /api/broadcast` is captured and answered without ever reaching the server, and
  any other POST that looks like a broadcast is aborted. Balances, positions, activity and
  proposals are a real public account's (`RETAIL_WALLET`), read as if the test key held them.
  The NFTs the flows move belong to a collection nobody controls, whose token reads the spec
  answers, and the recovery follows a swap whose tracking the spec answers as "delivery failed".
- Flows: a send with memo "a & b <c>", a send to a 32-byte address, an IBC transfer, claim,
  stake more, move stake, unstake, a vote on a live Hub proposal, a swap from the Hub (a
  transfer that runs Osmosis's swap contract), a contract swap from Osmosis, a swap in an
  Osmosis pool, the recovery of a swap whose delivery failed, and two NFT transfers, one whose
  token id holds "&". Keplr signs standard messages in amino and the rest in direct, Zunia 0.1.5
  signs everything in direct, Zunia 0.1.4 keeps the legacy policy on the sends, the contract
  swap and the NFT transfers (the one with "&" stops before anything is broadcast). A wallet
  that returns a signature over other bytes must be stopped before anything is broadcast. These
  are the expectations of a dashboard that reads the extension's capabilities and checks each
  signature before broadcasting (after a8cab18).
- Every broadcast must carry the test key, the memo as typed and the contract body the flow
  meant. On Zunia 0.1.5 every prompt must be decoded: no unknown message, and the sentence of
  contract F1 ("Give away NFT … from collection … to …", `Execute "recover" on …`, the packet
  memo notice on a swap from the Hub).

## CI

- **typecheck:** `pnpm typecheck` (the dashboard suite, and the signing harness through
  `signing/tsconfig.json`).
- **playwright:** the dashboard suite. Set the repository variable `E2E_BASE_URL` to a live
  dashboard preview or production.
- **relay-interop:** `stack/relay.spec.ts` against the main branches of zunia-sdk and
  zunia-backend. The extension specs need the kernel built from zunia-core, so they run
  locally.

## License

Apache-2.0.
