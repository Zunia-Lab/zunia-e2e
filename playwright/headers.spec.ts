/**
 * What the server says about its pages, read over plain HTTP: anti-framing
 * and the other security headers, the caching rules for personal data, and
 * the indexing rules (robots meta, canonical URLs, robots.txt, sitemap).
 */

import { canonicalLink, expect, robotsMeta, test } from "./support/dashboard";
import { RETAIL_WALLET } from "./support/mock-wallet";
import { INDEXABLE_PATHS, MOVED_PAGES, NOINDEX_PATHS, SITE_URL } from "./support/routes";

/** Every value of a header that may have been sent more than once (fetch joins them with ", "). */
function values(header: string | undefined): string[] {
  return (header ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

test.describe("security headers", () => {
  for (const path of ["/", "/markets", "/overview", "/send", "/settings"]) {
    test(`${path} cannot be framed`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      const headers = response.headers();
      // Clickjacking a send, swap or connect screen under a decoy page.
      expect(values(headers["x-frame-options"]), "X-Frame-Options").toEqual(["DENY"]);
      expect(headers["content-security-policy"], "enforced CSP").toMatch(/(^|;)\s*frame-ancestors 'none'\s*(;|$)/);
      expect(headers["content-security-policy"]).toMatch(/object-src 'none'/);
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["permissions-policy"]).toMatch(/camera=\(self\)/);
      expect(headers["permissions-policy"]).toMatch(/usb=\(\)/);
      expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
      expect(headers["x-powered-by"], "no framework banner").toBeUndefined();
    });
  }

  test("API answers are kept out of search and out of other sites' pages", async ({ request }) => {
    const response = await request.get("/api/health?live=1");
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["x-robots-tag"]).toBe("noindex");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(values(headers["x-frame-options"])).toEqual(["DENY"]);
  });

  test("an API request that names an address is never cached by a shared cache", async ({ request }) => {
    const accounts = `cosmoshub-4:${RETAIL_WALLET["cosmoshub-4"]}`;
    // A rejected request too: the rule follows the request, not the handler.
    for (const path of [`/api/portfolio?accounts=${encodeURIComponent(accounts)}`, "/api/portfolio?accounts=not-an-account"]) {
      const response = await request.get(path, { timeout: 60_000 });
      expect(response.headers()["cache-control"], path).toBe("private, no-store");
    }
  });

  test("the service worker is never served stale", async ({ request }) => {
    const response = await request.get("/sw.js");
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["cache-control"]).toBe("no-cache, max-age=0, must-revalidate");
    expect(headers["service-worker-allowed"]).toBe("/");
    expect(headers["content-security-policy"]).toBe("default-src 'self'");
  });
});

test.describe("indexing", () => {
  for (const path of NOINDEX_PATHS) {
    test(`${path} is noindex`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      const robots = robotsMeta(await response.text());
      expect(robots.length, "a robots meta tag").toBeGreaterThan(0);
      for (const content of robots) expect(content).toMatch(/\bnoindex\b/);
    });
  }

  for (const path of INDEXABLE_PATHS) {
    test(`${path} is indexable, with its canonical URL`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      const html = await response.text();
      const robots = robotsMeta(html);
      expect(robots.length, "a robots meta tag").toBeGreaterThan(0);
      for (const content of robots) {
        expect(content).toMatch(/\bindex\b/);
        expect(content).not.toMatch(/\bnoindex\b/);
      }
      const canonical = canonicalLink(html);
      expect(canonical, "canonical link").not.toBeNull();
      expect(new URL(canonical as string, SITE_URL).href).toBe(new URL(path, SITE_URL).href);
    });
  }

  test("robots.txt keeps crawlers out of /dev/ only and names the sitemap", async ({ request }) => {
    const response = await request.get("/robots.txt");
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toMatch(/^User-Agent: \*$/im);
    expect(text).toMatch(/^Allow: \/$/im);
    expect(text).toMatch(/^Disallow: \/dev\/$/im);
    expect(text).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
    // The public pages render from /api/*: a crawler blocked there indexes error states.
    expect(text).not.toMatch(/^Disallow: \/api/im);
  });

  test("sitemap.xml lists public pages only, and each answers 200 and is indexable", async ({ request }) => {
    test.setTimeout(180_000);
    const response = await request.get("/sitemap.xml");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/xml/);
    const locs = Array.from((await response.text()).matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1] as string);
    expect(locs.length).toBeGreaterThanOrEqual(8);
    const paths = locs.map((loc) => {
      expect(loc.startsWith(SITE_URL), `${loc} is on ${SITE_URL}`).toBe(true);
      const url = new URL(loc);
      return `${url.pathname}${url.search}`;
    });
    expect(new Set(paths).size, "no duplicates").toBe(paths.length);
    for (const path of ["/", "/markets", "/chains", "/validators", "/governance", "/compare", "/missions", "/apps"]) {
      expect(paths, `sitemap lists ${path}`).toContain(path);
    }
    // Curated chains come in pairs: the chain page and its validators.
    const chainPages = paths.filter((path) => path.startsWith("/chains/"));
    expect(chainPages.length).toBeGreaterThan(0);
    for (const chain of chainPages) {
      expect(paths).toContain(`/validators?chain=${chain.slice("/chains/".length)}`);
    }
    // Never a wallet page, a redirect or a playground.
    for (const path of paths) {
      expect(NOINDEX_PATHS, `${path} is a public page`).not.toContain(path);
      expect(MOVED_PAGES.map((moved) => moved.from)).not.toContain(path);
      expect(path.startsWith("/dev/")).toBe(false);
    }
    // Every entry answers 200 with an indexable page (a few at a time).
    const queue = [...paths];
    const failures: string[] = [];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
          const page = await request.get(path, { maxRedirects: 0, timeout: 60_000 });
          const robots = page.status() === 200 ? robotsMeta(await page.text()) : [];
          if (page.status() !== 200) failures.push(`${path}: HTTP ${page.status()}`);
          else if (robots.length === 0 || robots.some((content) => /\bnoindex\b/.test(content))) failures.push(`${path}: robots ${robots.join(" | ")}`);
        }
      }),
    );
    expect(failures).toEqual([]);
  });
});

test.describe("installable app", () => {
  test("the web app manifest is served", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);
    const manifest = (await response.json()) as { name?: unknown; start_url?: unknown; icons?: unknown };
    expect(typeof manifest.name).toBe("string");
    expect(typeof manifest.start_url).toBe("string");
    expect(Array.isArray(manifest.icons) && manifest.icons.length > 0).toBe(true);
  });
});
