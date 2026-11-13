import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SecretBoxOpenError,
  SecretBoxUnavailableError,
  openSecret,
  sealSecret,
  secretBoxAvailable,
} from "@/lib/secret-box";

/*
 * Value: protects=a stored provider key being unreadable from a database dump
 * and unusable on another workspace's row; fails_when=the plaintext appears in
 * the sealed text, a tampered or re-homed envelope opens, or a missing key
 * silently stores in the clear; seam=the real AES-GCM envelope with a real
 * key; no_claim=key rotation (a rotated key re-seals by re-saving).
 */

const env = { SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const secret = "sk-test-abcdef1234567890";

describe("secret box", () => {
  it("round-trips and never contains the plaintext", () => {
    const sealed = sealSecret(secret, "ws-1:openai", env);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(secret);
    expect(sealed).not.toContain("abcdef");
    expect(openSecret(sealed, "ws-1:openai", env)).toBe(secret);
  });

  it("seals the same secret differently each time", () => {
    expect(sealSecret(secret, "c", env)).not.toBe(sealSecret(secret, "c", env));
  });

  it("refuses an envelope moved to another owner", () => {
    const sealed = sealSecret(secret, "ws-1:openai", env);
    expect(() => openSecret(sealed, "ws-2:openai", env)).toThrow(SecretBoxOpenError);
    expect(() => openSecret(sealed, "ws-1:groq", env)).toThrow(SecretBoxOpenError);
  });

  it("refuses a tampered envelope and the wrong key", () => {
    const sealed = sealSecret(secret, "c", env);
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => openSecret(parts.join("."), "c", env)).toThrow(SecretBoxOpenError);
    const other = { SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
    expect(() => openSecret(sealed, "c", other)).toThrow(SecretBoxOpenError);
    expect(() => openSecret("not-an-envelope", "c", env)).toThrow(SecretBoxOpenError);
  });

  it("will not seal without a valid key, and error text never carries the secret", () => {
    for (const bad of [{}, { SECRETS_ENCRYPTION_KEY: "" }, { SECRETS_ENCRYPTION_KEY: "c2hvcnQ=" }]) {
      expect(secretBoxAvailable(bad)).toBe(false);
      expect(() => sealSecret(secret, "c", bad)).toThrow(SecretBoxUnavailableError);
    }
    try {
      openSecret("v1.a.b.c", "c", env);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
