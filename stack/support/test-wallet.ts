import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  ConnectCipher,
  adr36SignDoc,
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  deriveConnectKeys,
  generateConnectKeyPair,
  parsePairingUri,
  pubkeyToAddress,
  serializeAminoSignDoc,
  utf8ToBytes,
  type ConnectEnvelope,
  type WireAccount,
} from "./sdk";

export type RelayFrame = { t: string } & Record<string, unknown>;

/**
 * The phone side of zunia.connect.v2 in miniature, talking to the real relay:
 * it scans a pairing link, derives the session keys, answers requests with a
 * real secp256k1 key, and comes back with the resume token like the app does.
 */
export class TestWallet {
  readonly secretKey = secp256k1.utils.randomSecretKey();
  readonly publicKey = secp256k1.getPublicKey(this.secretKey, true);
  readonly address = pubkeyToAddress(this.publicKey, "cosmos");
  /** Decrypted messages from the site, in order. */
  readonly received: ConnectEnvelope[] = [];
  /** Every frame the relay sent, as it arrived. */
  readonly frames: RelayFrame[] = [];
  welcome: RelayFrame | null = null;
  verificationCode = "";
  closeCode: number | null = null;
  private socket: WebSocket | null = null;
  private cipher: ConnectCipher | null = null;
  private url = "";
  private resumeToken = "";
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private handled = new Set<ConnectEnvelope>();

  account(chainId: string): WireAccount {
    return { chainId, address: this.address, algo: "secp256k1", pubKey: bytesToBase64(this.publicKey), name: "E2E" };
  }

  async scan(uri: string): Promise<void> {
    const link = parsePairingUri(uri);
    if (!link) throw new Error(`Not a pairing link: ${uri}`);
    const own = generateConnectKeyPair();
    const keys = deriveConnectKeys({
      role: "wallet",
      sessionId: link.sessionId,
      secretKey: own.secretKey,
      peerPublicKey: base64UrlToBytes(link.dappPublicKey),
    });
    this.cipher = new ConnectCipher({ role: "wallet", sessionId: link.sessionId, keys });
    this.verificationCode = keys.verificationCode;
    this.url = `${link.relay}/v1/connect/ws?sid=${link.sessionId}&role=wallet`;
    await this.open(link.joinToken);
    this.send({ t: "hello", pk: bytesToBase64Url(own.publicKey) });
  }

  /** Approves the site's connect request with this wallet's account on each chain. */
  async approve(): Promise<void> {
    const request = await this.next("connect_request");
    const chains = (request.payload as { chains: string[] }).chains;
    this.seal({
      type: "connect_approve",
      id: request.id,
      payload: { accounts: chains.map((chainId) => this.account(chainId)), chains, wallet: { name: "Zunia e2e" } },
    });
    this.send({ t: "paired" });
  }

  /** The next message of this type from the site that no earlier call returned. */
  async next(type: string, timeoutMs = 10_000): Promise<ConnectEnvelope> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const message = this.received.find((item) => item.type === type && !this.handled.has(item));
      if (message) {
        this.handled.add(message);
        return message;
      }
      if (Date.now() > deadline) throw new Error(`No ${type} from the site within ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Signs the site's `sign_arbitrary` request (ADR-36), as the app does after approval. */
  async answerSignArbitrary(): Promise<void> {
    const request = await this.next("sign_arbitrary");
    const payload = request.payload as { signer: string; data: string; encoding?: string };
    if (payload.signer !== this.address) throw new Error(`Asked to sign for ${payload.signer}`);
    const data = payload.encoding === "base64" ? base64ToBytes(payload.data) : utf8ToBytes(payload.data);
    const digest = sha256(serializeAminoSignDoc(adr36SignDoc(this.address, data)));
    const signature = secp256k1.sign(digest, this.secretKey, { prehash: false });
    this.seal({
      type: "result",
      id: request.id,
      payload: {
        pub_key: { type: "tendermint/PubKeySecp256k1", value: bytesToBase64(this.publicKey) },
        signature: bytesToBase64(signature),
      },
    });
  }

  /** Drops the connection without ending the session, like a phone losing signal. */
  goOffline(): void {
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  /** Reconnects with the resume token the relay handed out on the first join. */
  reconnect(): Promise<void> {
    return this.open(this.resumeToken);
  }

  /** Tries to join with a secret of our choosing and resolves with the close code. */
  static async refused(url: string, secret: string): Promise<number> {
    return new Promise((resolve) => {
      const socket = new WebSocket(url, ["zunia.connect.v2", `zunia.token.${secret}`]);
      socket.onclose = (event) => resolve(event.code);
    });
  }

  end(): void {
    this.send({ t: "close" });
    this.goOffline();
  }

  seal(message: Omit<ConnectEnvelope, "seq">): void {
    const frame = this.cipher!.seal(message);
    this.send({ t: "msg", n: frame.n, c: frame.c });
  }

  send(frame: RelayFrame): void {
    this.socket?.send(JSON.stringify(frame));
  }

  get joinUrl(): string {
    return this.url;
  }

  private open(secret: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, ["zunia.connect.v2", `zunia.token.${secret}`]);
      this.socket = socket;
      this.closeCode = null;
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as RelayFrame;
        this.frames.push(frame);
        if (frame.t === "welcome") {
          this.welcome = frame;
          if (typeof frame.resumeToken === "string") this.resumeToken = frame.resumeToken;
          this.startHeartbeat();
          resolve();
        } else if (frame.t === "msg" && this.cipher) {
          // Null for a copy the site resent after reconnecting.
          const message = this.cipher.openFresh({ n: String(frame.n), c: String(frame.c) });
          if (message) this.received.push(message);
        }
      };
      socket.onclose = (event) => {
        if (this.socket === socket) this.stopHeartbeat();
        this.closeCode = event.code;
        reject(new Error(`The relay closed the socket (${event.code})`));
      };
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.send({ t: "ping" }), 10_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
