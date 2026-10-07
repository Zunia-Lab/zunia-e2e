/** Collects what a tier found that its expectations did not say, and prints it. */
export class Findings {
  readonly deviations: string[] = [];

  /** Records a deviation unless `actual` equals `expected`. */
  expect(row: string, what: string, actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      this.deviations.push(`${row}: ${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }

  /** Records a deviation unless `ok`. */
  require(row: string, ok: boolean, problem: string): void {
    if (!ok) this.deviations.push(`${row}: ${problem}`);
  }

  /** Prints the deviations, or that there were none, and sets the exit code. */
  finish(summary: string): void {
    console.log(summary);
    if (this.deviations.length === 0) {
      console.log("Every row matches its expectation.");
      return;
    }
    console.log(`${this.deviations.length} deviation(s) from the expectations:`);
    for (const line of this.deviations) console.log(`  - ${line}`);
    process.exitCode = 1;
  }
}

/** A table with long cells cut to `width`, so a row stays on one line. */
export function printTable(rows: Array<Record<string, string>>, width = 64): void {
  console.table(
    rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value.length > width ? `${value.slice(0, width - 1)}…` : value])),
    ),
  );
}

/** Runs an entry point and turns an uncaught error into exit code 1 with its message. */
export function run(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}

/** Whether `haystack` holds a node deep-equal to `needle` (a contract body, a memo string). */
export function containsValue(haystack: unknown, needle: unknown): boolean {
  const target = JSON.stringify(sorted(needle));
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 64) return false;
    if (JSON.stringify(sorted(node)) === target) return true;
    if (Array.isArray(node)) return node.some((item) => visit(item, depth + 1));
    if (node && typeof node === "object") return Object.values(node).some((item) => visit(item, depth + 1));
    // A contract body or memo can also arrive as a JSON string.
    if (typeof node === "string" && typeof needle !== "string" && /^[[{]/.test(node)) {
      try {
        return visit(JSON.parse(node), depth + 1);
      } catch {
        return false;
      }
    }
    return false;
  };
  return visit(haystack, 0);
}

function sorted(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sorted);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sorted(record[key])]),
  );
}
