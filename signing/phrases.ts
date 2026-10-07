/**
 * The only phrases any Zunia test signs with: the public BIP39 test vectors.
 * Anyone can derive their keys, so never fund them, and never put a real
 * wallet's phrase in a test.
 */

/** The wallet's first account. */
export const MNEMONIC = `${"abandon ".repeat(11)}about`;

/** An account added next to it with its own phrase (ADD_ACCOUNT_SEED, "Add account → Restore with phrase"). */
export const ADDED_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
