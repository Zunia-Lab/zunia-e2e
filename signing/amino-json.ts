/**
 * Amino JSON the way a chain rebuilds it, the rule every Zunia serializer
 * follows from 0.1.5 (contract A1):
 *
 * 1. keys sorted recursively;
 * 2. compact JSON;
 * 3. `&`, `<`, `>` written as \u0026, \u003c, \u003e (CosmJS and Keplr do too);
 * 4. U+2028 and U+2029 written as \u2028 and \u2029, as Go's json.Marshal
 *    does and CosmJS does not;
 * 5. UTF-8.
 *
 * Cosmos SDK x/tx aminojson writes strings with Go's json.Marshal. go/escape.go
 * prints what Go writes, and the self-test compares it with this module when a
 * Go toolchain is installed.
 */

export function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
}

/** The escapes Go writes inside strings and JSON.stringify does not. */
export function escapeLikeGo(json: string): string {
  return json
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function aminoJson(doc: unknown): string {
  return escapeLikeGo(JSON.stringify(sortKeys(doc)));
}

/** The bytes a wallet signs for an amino document (sha256 of these is the digest). */
export function aminoSignBytes(doc: unknown): Uint8Array {
  return new TextEncoder().encode(aminoJson(doc));
}

/** What a serializer without any escaping writes: Zunia 0.1.4 and older. */
export function unescapedAminoBytes(doc: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(sortKeys(doc)));
}

/** Whether A1 writes this document differently from a serializer that escapes nothing. */
export function needsEscaping(doc: unknown): boolean {
  const plain = JSON.stringify(sortKeys(doc));
  return escapeLikeGo(plain) !== plain;
}

export interface AminoMsg {
  type: string;
  value: Record<string, unknown>;
}

export interface StdFee {
  amount: Array<{ denom: string; amount: string }>;
  gas: string;
  payer?: string;
  granter?: string;
}

export interface StdSignDoc {
  chain_id: string;
  account_number: string;
  sequence: string;
  fee: StdFee;
  msgs: AminoMsg[];
  memo: string;
  timeout_height?: string;
}

/**
 * The ADR-36 document `signArbitrary` signs: an amino document with one
 * `sign/MsgSignData`, empty chain id, zero fee and zero account.
 */
export function adr36SignDoc(signer: string, data: Uint8Array): StdSignDoc {
  return {
    chain_id: "",
    account_number: "0",
    sequence: "0",
    fee: { gas: "0", amount: [] },
    msgs: [{ type: "sign/MsgSignData", value: { signer, data: Buffer.from(data).toString("base64") } }],
    memo: "",
  };
}
