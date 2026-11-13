import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/*
 * Envelope for secrets stored at rest (a workspace's own model-provider key).
 * The repo had no encryption helper, so this is the one.
 *
 * Scheme: AES-256-GCM with a fresh random 96-bit nonce per seal. The key is
 * SECRETS_ENCRYPTION_KEY, 32 random bytes as base64 (`openssl rand -base64 32`),
 * held in the deployment's env and never in the database, so a database dump
 * alone reveals nothing. The sealed form is `v1.<nonce>.<tag>.<ciphertext>`,
 * each part base64url; the `v1` prefix is what a later scheme or key rotation
 * keys off (rotate by re-saving the secrets, which re-seals them under the new
 * key). `context` is bound in as additional authenticated data (we pass
 * `<workspaceId>:<provider>`), so a ciphertext copied onto another workspace's
 * row fails to open instead of decrypting into the wrong tenant.
 *
 * Errors never carry the plaintext, the key, or the sealed text.
 */

const VERSION = "v1";
const KEY_BYTES = 32;

export class SecretBoxUnavailableError extends Error {
  constructor() {
    super(
      "This deployment has no SECRETS_ENCRYPTION_KEY, so it cannot store keys. Set it to 32 random bytes as base64.",
    );
    this.name = "SecretBoxUnavailableError";
  }
}

export class SecretBoxOpenError extends Error {
  constructor() {
    super("A stored secret could not be opened. It was sealed with a different key or for a different owner.");
    this.name = "SecretBoxOpenError";
  }
}

function keyFrom(env: Record<string, string | undefined>): Buffer {
  const raw = env.SECRETS_ENCRYPTION_KEY?.trim();
  if (!raw) throw new SecretBoxUnavailableError();
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) throw new SecretBoxUnavailableError();
  return key;
}

export function secretBoxAvailable(env: Record<string, string | undefined> = process.env): boolean {
  try {
    keyFrom(env);
    return true;
  } catch {
    return false;
  }
}

export function sealSecret(
  plaintext: string,
  context: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(env), nonce);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, nonce, cipher.getAuthTag(), body]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function openSecret(
  sealed: string,
  context: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const [version, nonce, tag, body] = sealed.split(".");
  if (version !== VERSION || !nonce || !tag || body === undefined) throw new SecretBoxOpenError();
  const key = keyFrom(env);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretBoxOpenError();
  }
}
