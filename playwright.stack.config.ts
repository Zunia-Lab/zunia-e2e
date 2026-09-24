import { defineConfig } from "@playwright/test";
import { DAPP_PORT, DAPP_URL, RELAY_PORT, RELAY_URL, WORKSPACE } from "./stack/support/env";

/**
 * The whole stack from the checkouts next to this repo: the extension builds,
 * the SDK's example dApp and the backend relay. See "Extension and relay" in
 * README.md.
 */
export default defineConfig({
  testDir: "./stack",
  workers: 1,
  timeout: 120_000,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-stack" }]],
  use: { trace: "retain-on-failure" },
  webServer: [
    {
      command: `pnpm exec vite --port ${DAPP_PORT} --strictPort`,
      cwd: `${WORKSPACE}/zunia-sdk/examples/dapp`,
      url: DAPP_URL,
      // The example's sign-in server only accepts messages signed for its own host.
      env: { SIGN_IN_DOMAIN: new URL(DAPP_URL).host, VITE_ZUNIA_API: RELAY_URL },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "node --import tsx src/server.ts",
      cwd: `${WORKSPACE}/zunia-backend`,
      url: `${RELAY_URL}/health`,
      env: { PORT: String(RELAY_PORT), DATABASE_URL: "" },
      reuseExistingServer: !process.env.CI,
    },
  ],
});
