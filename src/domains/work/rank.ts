/*
 * Fractional ranks: a drag writes one row. A rank is a non-empty lowercase
 * string; generated ranks never end in "a" (so there is always room before
 * them), but a stored "a" is accepted and has nothing below it. Order is
 * plain byte order, which is why queries sort `rank collate "C"`.
 *
 * `rankBetween(before, after)` returns a string strictly between the two; a
 * null bound is open. Digits are base 26, a-z.
 */

const LOW = 97; // "a"
const BASE = 26;

const code = (c: string) => c.charCodeAt(0) - LOW;
const char = (n: number) => String.fromCharCode(LOW + n);

function between(a: string, b: string | null): string {
  if (b === "") throw new Error("rankBetween: no room between these ranks");
  if (b !== null) {
    let n = 0;
    while (n < b.length && (a[n] ?? "a") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + between(a.slice(n), b.slice(n));
  }
  const lo = a ? code(a[0]) : 0;
  const hi = b !== null ? code(b[0]) : BASE;
  if (hi - lo > 1) return char(Math.floor((lo + hi) / 2));
  // Adjacent digits. If b has more digits, its first digit alone is already
  // between a and b; otherwise keep a's digit and find room after it.
  if (b !== null && b.length > 1) return b[0];
  return char(lo) + between(a.slice(1), null);
}

export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) {
    throw new Error("rankBetween: before must sort below after");
  }
  if (before !== null && !/^[a-z]+$/.test(before)) throw new Error("rankBetween: invalid rank");
  if (after !== null && !/^[a-z]+$/.test(after)) throw new Error("rankBetween: invalid rank");
  const rank = between(before ?? "", after);
  if ((before !== null && rank <= before) || (after !== null && rank >= after)) {
    throw new Error("rankBetween: no room between these ranks");
  }
  return rank;
}
