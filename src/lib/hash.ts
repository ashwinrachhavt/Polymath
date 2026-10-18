/*
 * The one digest helper. Content hashes, dedupe keys, and receipt hashes all
 * need "bytes in, hex out" — three copies grew across the tree before this
 * lived here, so every future call site imports rather than re-rolls.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
