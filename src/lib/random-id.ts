/*
 * A random id for anything the browser mints on its own: a pending message, a
 * request key, a local row. `crypto.randomUUID` exists only in a secure
 * context, and the app is routinely opened at http://0.0.0.0:3000 or on a
 * phone at a LAN address, where it is undefined and a send died with
 * "crypto.randomUUID is not a function".
 *
 * getRandomValues has no such restriction, so this builds an RFC 4122 v4 id
 * from it; the last resort keeps a non-crypto page working rather than losing
 * the person's words. The ids are local only — anything that must be
 * unguessable is minted on the server.
 */
export function randomId(): string {
  // getRandomValues has no secure-context requirement and exists in every
  // supported browser and Node, so there is no fallback to fall back to.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Version 4, variant 10xx.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
    .slice(8, 10)
    .join("")}-${hex.slice(10, 16).join("")}`;
}
