/**
 * The dashboard's pages, as the smoke and header specs walk them.
 *
 * Titles are the documents' `<title>` (the root template appends " · Zunia";
 * the landing page sets its own). `heading` is the page's one h1: inside the
 * app frame it is the page title `<Page>` renders (visually hidden, the top
 * bar shows the same words).
 *
 * Detail pages whose identifiers come from live data (a validator, a
 * proposal, an asset, a transaction) are not listed here: the specs read an
 * identifier from the API first (see smoke.spec.ts).
 */

export interface RouteCase {
  path: string;
  title: string | RegExp;
  heading: string | RegExp;
}

/** Render without a wallet. All but the last two are indexable (sitemap). */
export const PUBLIC_ROUTES: readonly RouteCase[] = [
  { path: "/", title: "Zunia — Every Cosmos chain, one decision desk", heading: /^Every Cosmos chain\.\s*One decision desk\.$/ },
  { path: "/markets", title: "Cosmos markets: prices, volume and liquidity · Zunia", heading: "Markets" },
  { path: "/chains", title: "Cosmos chains compared: staking APR, real yield, validators · Zunia", heading: "Chains" },
  { path: "/chains/cosmoshub-4", title: "Cosmos Hub (ATOM) staking APR, validators and economics · Zunia", heading: "Cosmos Hub" },
  { path: "/validators", title: "Cosmos validators · Zunia", heading: "Validators" },
  { path: "/validators?chain=cosmoshub-4", title: "Cosmos Hub validators · Zunia", heading: "Validators" },
  { path: "/governance", title: "Cosmos governance · Zunia", heading: "Governance" },
  { path: "/compare", title: "Compare Cosmos chains and tokens side by side · Zunia", heading: "Compare" },
  { path: "/missions", title: "Missions (coming soon) · Zunia", heading: "Missions" },
  { path: "/apps", title: "Apps (coming soon) · Zunia", heading: "Apps" },
  // Public but personal (followed chains, preferences): noindex.
  { path: "/networks", title: "Manage networks · Zunia", heading: "Manage networks" },
  { path: "/settings", title: "Settings · Zunia", heading: "Settings" },
];

/** Indexable public pages (robots `index`, a canonical URL). */
export const INDEXABLE_PATHS = ["/", "/markets", "/chains", "/chains/cosmoshub-4", "/validators", "/governance", "/compare", "/missions", "/apps"];

/** Show the connect panel in place of their content until a wallet is linked; noindex. */
export const WALLET_ROUTES: readonly RouteCase[] = [
  { path: "/overview", title: "Overview · Zunia", heading: "Overview" },
  { path: "/assets", title: "Assets · Zunia", heading: "Assets" },
  { path: "/activity", title: "Activity · Zunia", heading: "Activity" },
  { path: "/send", title: "Send · Zunia", heading: "Send" },
  { path: "/receive", title: "Receive · Zunia", heading: "Receive" },
  { path: "/swap", title: "Swap · Zunia", heading: "Swap" },
  { path: "/bridge", title: "Bridge · Zunia", heading: "Bridge" },
  { path: "/staking", title: "Staking · Zunia", heading: "Staking" },
  { path: "/insights", title: "Insights · Zunia", heading: "Insights" },
  { path: "/nfts", title: "NFTs · Zunia", heading: "NFTs" },
  { path: "/notifications", title: "Notifications · Zunia", heading: "Notifications" },
];

/** Pages that must never be search results. */
export const NOINDEX_PATHS = [...WALLET_ROUTES.map((route) => route.path), "/networks", "/settings"];

/** Moved pages: permanent redirects answered before rendering (next.config.ts). */
export const MOVED_PAGES: ReadonlyArray<{ from: string; to: string }> = [
  { from: "/portfolio", to: "/overview" },
  { from: "/dapps", to: "/apps" },
  // Zunia Mobile is a way to connect (the Connect wallet modal), not a page.
  { from: "/mobile", to: "/?connect=mobile" },
];

/** Where production lives: sitemap, robots and canonical URLs name it whatever host serves them. */
export const SITE_URL = "https://app.zunialab.com";
