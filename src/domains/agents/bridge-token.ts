import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/*
 * The verified workspace binding between the app and the Eve agent. The app has
 * already authenticated the caller (Clerk) and resolved their workspace; this
 * carries that result to Eve as a short-lived signed assertion, replacing the
 * old asserted `x-spike-clerk-user-id` header that anyone could send.
 *
 * Shape: `v1.<payload>.<signature>`, base64url, HMAC-SHA256 over
 * `v1.<payload>` with EVE_BRIDGE_SECRET. The payload names the internal user,
 * workspace and role, an audience, and an expiry of at most 60 seconds, so a
 * captured token is useless almost immediately. Eve verifies the signature and
 * then re-checks the membership in the database (verifyWorkspaceBinding), so a
 * suspended member or a removed workspace stops working inside the window too.
 *
 * Node `crypto` only and no database import, so the Eve bundle can load it.
 */

export const BRIDGE_AUDIENCE = "axiom-eve";
export const BRIDGE_TOKEN_TTL_SECONDS = 60;
const MIN_SECRET_LENGTH = 32;
/** Tolerated clock difference between the app and Eve, in seconds. */
const CLOCK_SKEW_SECONDS = 5;

export type BridgeClaims = {
  userId: string;
  workspaceId: string;
  role: "owner" | "admin" | "member" | "viewer";
  /*
   * Optional because most Eve calls (the chat stream, cancel) belong to no run
   * and pin no skill. When present they are signed, so the agent can trust them
   * exactly as much as the workspace id: a run's skill pin travels with the
   * request instead of through a row written after session creation, which
   * removes the race the specialist brief has to work around.
   */
  runId?: string;
  skillId?: string;
  /*
   * The run's frozen model. The run row records one model for pricing; without
   * this claim the agent resolved its own default, so a run recorded mercury-3
   * while Gemini answered and billed — two numbers that disagreed and only one
   * of them was real.
   */
  model?: string;
};

type Payload = {
  uid: string;
  wid: string;
  role: BridgeClaims["role"];
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  rid?: string;
  skid?: string;
  mdl?: string;
};

/** The shared secret, or null when it is missing or too short to trust. */
export function bridgeSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.EVE_BRIDGE_SECRET?.trim();
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

const encode = (value: string | Buffer) => Buffer.from(value).toString("base64url");
const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest();

export function signBridgeToken(
  claims: BridgeClaims,
  options: { secret: string; now?: Date; ttlSeconds?: number },
): string {
  if (options.secret.length < MIN_SECRET_LENGTH) throw new Error("EVE_BRIDGE_SECRET is too short.");
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const ttl = Math.min(options.ttlSeconds ?? BRIDGE_TOKEN_TTL_SECONDS, BRIDGE_TOKEN_TTL_SECONDS);
  const payload: Payload = {
    uid: claims.userId,
    wid: claims.workspaceId,
    role: claims.role,
    aud: BRIDGE_AUDIENCE,
    iat,
    exp: iat + ttl,
    jti: randomUUID(),
    // Omitted, not set to undefined: a token without these must serialise to
    // exactly the bytes earlier versions produced.
    ...(claims.runId !== undefined ? { rid: claims.runId } : {}),
    ...(claims.skillId !== undefined ? { skid: claims.skillId } : {}),
    ...(claims.model !== undefined ? { mdl: claims.model } : {}),
  };
  const body = `v1.${encode(JSON.stringify(payload))}`;
  return `${body}.${encode(sign(options.secret, body))}`;
}

/** Claims when the token is genuine, for this audience, and unexpired; otherwise null and no reason. */
export function verifyBridgeToken(
  token: string,
  options: { secret: string; now?: Date },
): BridgeClaims | null {
  if (options.secret.length < MIN_SECRET_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const body = `${parts[0]}.${parts[1]}`;
  const given = Buffer.from(parts[2], "base64url");
  const expected = sign(options.secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Payload;
  } catch {
    return null;
  }
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (payload.aud !== BRIDGE_AUDIENCE) return null;
  if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat)) return null;
  if (payload.exp <= now - CLOCK_SKEW_SECONDS) return null;
  if (payload.iat > now + CLOCK_SKEW_SECONDS) return null;
  if (payload.exp - payload.iat > BRIDGE_TOKEN_TTL_SECONDS) return null;
  if (typeof payload.uid !== "string" || typeof payload.wid !== "string") return null;
  if (!["owner", "admin", "member", "viewer"].includes(payload.role)) return null;
  // A claim that is present but not a string is malformed, not absent: the
  // signer here only ever writes strings, so the payload was built by other
  // code — refuse rather than pass a non-string into a database lookup.
  if (payload.rid !== undefined && typeof payload.rid !== "string") return null;
  if (payload.skid !== undefined && typeof payload.skid !== "string") return null;
  if (payload.mdl !== undefined && typeof payload.mdl !== "string") return null;
  return {
    userId: payload.uid,
    workspaceId: payload.wid,
    role: payload.role,
    ...(payload.rid !== undefined ? { runId: payload.rid } : {}),
    ...(payload.skid !== undefined ? { skillId: payload.skid } : {}),
    ...(payload.mdl !== undefined ? { model: payload.mdl } : {}),
  };
}
