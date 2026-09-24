# zunia-e2e

End-to-end tests for Zunia. They run the browser extension, the JS SDK, the Connect relay and
the phone wallet together, from the checkouts next to this repo, so they test the code as it
is now rather than a release.

## Layout

```
stack/        Playwright: the extension and the SDK against the relay
maestro/      Maestro: the phone wallet pairing with a site
scripts/      Drivers that start what a suite needs, then run it
playwright/   Playwright: dashboard smoke test
```

## Before you start

The stack and phone suites expect the other repositories next to this one:

```
zunia/
  zunia-e2e/
  zunia-sdk/         pnpm install && pnpm build
  zunia-backend/     pnpm install
  zunia-extension/   pnpm build:chrome && pnpm build:firefox (the kernel comes from zunia-core)
  zunia-mobile/      a debug build, for the phone flow only
```

The Firefox spec also needs a stock Firefox, found in `/Applications` or through `FIREFOX_BIN`.
Then, in this repo:

```bash
pnpm install
pnpm exec playwright install chromium
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
  Content-Security-Policy blocks injected scripts. It then
  restores a test wallet, connects from the example dApp, signs in and has the example's server
  verify it, signs an Amino transaction and checks the signature, then switches accounts and
  revokes the site in the wallet and checks that the page hears both live.
- `stack/firefox.spec.ts` runs the same checks on `.output/firefox-mv3` in a stock Firefox.
  Playwright's Firefox cannot load extensions, so puppeteer-core drives Firefox over WebDriver
  BiDi. Firefox has no IntersectionObserver v2, so the extension does not draw its in-page
  connect prompt there, and the spec approves the connect request from the toolbar popup's
  queue. Firefox unloads an idle background page after 30 seconds; the spec shortens that to
  5, so the extension also comes back from it between steps, and a last check makes sure the
  wallet is still unlocked afterwards. The spec skips itself when Firefox is missing.

The test wallet uses the public CosmJS test mnemonic. Never send funds to it.

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
reach in Chrome and Firefox either, such as Direct signing, lock and unlock, and revoking a
single chain.

## Dashboard smoke (playwright/)

`pnpm test:web` opens the dashboard at `E2E_BASE_URL` (default `http://127.0.0.1:3000`) and
checks its title and heading. The test skips itself when nothing answers there.

## CI

- **typecheck:** `pnpm typecheck`.
- **playwright:** the dashboard smoke test. Set the repository variable `E2E_BASE_URL` to a
  live dashboard preview.
- **relay-interop:** `stack/relay.spec.ts` against the main branches of zunia-sdk and
  zunia-backend. The extension specs need the kernel built from zunia-core, so they run
  locally.

## License

Apache-2.0.
