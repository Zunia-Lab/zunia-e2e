import { createServer, type Server } from "node:http";

/**
 * Pages whose Content-Security-Policy blocks what a careless extension would
 * inject: inline scripts, scripts without the page's nonce, and DOM sinks
 * without a Trusted Types policy. The provider has to reach every one. Each
 * page also loads /check.js the way its policy allows, to show the page's own
 * scripts still run beside the wallet.
 */
export const CSP_PAGES: Record<string, string | null> = {
  "/open": null,
  "/strict": "default-src 'none'; script-src 'self'; connect-src 'self'",
  "/nonce": "default-src 'none'; script-src 'nonce-e2e' 'strict-dynamic'",
  "/trusted-types":
    "default-src 'none'; script-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'",
};

export function startCspPages(port: number): Promise<Server> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/check.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("window.pageScriptRan = true;");
      return;
    }
    if (!(path in CSP_PAGES)) {
      response.writeHead(404).end();
      return;
    }
    const policy = CSP_PAGES[path];
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      ...(policy ? { "content-security-policy": policy } : {}),
    });
    response.end(`<!doctype html><title>${path}</title><script src="/check.js" nonce="e2e"></script><p>ok</p>`);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

export interface ProviderProbe {
  pageScript: boolean;
  provider: boolean;
  connectedChains: string[] | null;
}

/**
 * Runs inside the page. `getConnectedChains` goes page, content script,
 * background and back without prompting, so an answer means the whole
 * channel works under the page's policy.
 */
export async function probeProvider(): Promise<ProviderProbe> {
  const page = window as unknown as {
    pageScriptRan?: boolean;
    zunia?: { getConnectedChains: () => Promise<string[]> };
  };
  for (let attempt = 0; attempt < 50 && !page.zunia; attempt++) {
    await new Promise((done) => setTimeout(done, 100));
  }
  return {
    pageScript: page.pageScriptRan === true,
    provider: Boolean(page.zunia),
    connectedChains: page.zunia ? await page.zunia.getConnectedChains() : null,
  };
}
