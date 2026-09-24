import { createServer, connect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

/**
 * A TCP hop in front of the relay that can cut the site's connections, so a
 * test can take the network away from one side and give it back.
 */
export class TcpProxy {
  private server: Server | null = null;
  private readonly links = new Set<{ client: Socket; upstream: Socket; head: string }>();
  port = 0;

  constructor(private readonly target: { host: string; port: number }) {}

  async start(): Promise<void> {
    this.server = createServer((client) => {
      const upstream = connect(this.target);
      const link = { client, upstream, head: "" };
      this.links.add(link);
      client.once("data", (chunk) => {
        link.head = chunk.toString("latin1", 0, Math.min(chunk.length, 512));
      });
      client.pipe(upstream);
      upstream.pipe(client);
      const close = () => {
        this.links.delete(link);
        client.destroy();
        upstream.destroy();
      };
      client.on("error", close).on("close", close);
      upstream.on("error", close).on("close", close);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** Cuts every open connection whose first request line contains `marker`, without a close frame. */
  cut(marker: string): number {
    let count = 0;
    for (const link of [...this.links]) {
      if (!link.head.includes(marker)) continue;
      link.client.destroy();
      link.upstream.destroy();
      count += 1;
    }
    return count;
  }

  async stop(): Promise<void> {
    for (const link of this.links) {
      link.client.destroy();
      link.upstream.destroy();
    }
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
