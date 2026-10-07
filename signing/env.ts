import { resolve } from "node:path";

/**
 * Where the signing harness finds what it tests. Every path comes from the
 * environment and falls back to the checkouts next to this repo, as in the
 * Zunia-Lab workspace:
 *
 * - WORKSPACE: the folder that holds zunia-e2e, zunia-core, zunia-extension
 *   and zunia-dashboard.
 * - EXT_SRC: the extension's source tree. Its own amino serializer and
 *   builders run as they are (Tier 0, own flows, Tier 2a).
 * - EXT_DIR: an unpacked Chromium build of the extension (Tier 1).
 * - KERNEL: the kernel's Node entry, zunia-core's packages/npm, which is the
 *   wasm every extension checkout links.
 * - DASHBOARD_SRC: the dashboard checkout whose sign flow Tier 2a drives.
 */

export const WORKSPACE = resolve(process.env.WORKSPACE ?? resolve(__dirname, "../.."));
export const EXT_SRC = resolve(process.env.EXT_SRC ?? `${WORKSPACE}/zunia-extension`);
export const EXT_DIR = resolve(process.env.EXT_DIR ?? `${EXT_SRC}/.output/chrome-mv3`);
export const KERNEL = resolve(process.env.KERNEL ?? `${WORKSPACE}/zunia-core/packages/npm/node/index.mjs`);
export const DASHBOARD_SRC = resolve(process.env.DASHBOARD_SRC ?? `${WORKSPACE}/zunia-dashboard`);

/** Builds whose results a run is compared with. See expectations.ts. */
export const BUILDS = ["0.1.3", "0.1.4", "0.1.5"] as const;
export type Build = (typeof BUILDS)[number];

/**
 * The build a run is judged as: 0.1.5, the release the harness gates, unless
 * SIGNING_EXPECT names a legacy build. Judging a legacy build as itself is how
 * the harness shows it still sees the known failures. It is never guessed from
 * the build, so an old build cannot pass as the release by mistake.
 */
export function expectedBuild(): Build {
  const value = process.env.SIGNING_EXPECT ?? "0.1.5";
  if (!(BUILDS as readonly string[]).includes(value)) {
    throw new Error(`SIGNING_EXPECT must be one of ${BUILDS.join(", ")}, not "${value}"`);
  }
  return value as Build;
}

/** Only rows whose case name matches ONLY (a regular expression, case-insensitive). */
export const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;
