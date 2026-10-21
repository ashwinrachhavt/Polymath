import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/*
 * The run-scoped credential eve presents to the provider gateway. Separate from
 * bridge-token.ts by design: that token authenticates a person *to* eve, this
 * one authenticates eve *to* one run. The claim sets, the audience, and the
 * secret differ, and a single parameterised signer invites a call site that
 * passes the wrong secret to the wrong endpoint.
 *
 * Shape: `v1.<payload>.<signature>`, base64url, HMAC-SHA256 over
 * `v1.<payload>` with EVE_GATEWAY_SECRET. `rid` is the primary claim, so a
 * captured token is usable against exactly one run, and only for 60 seconds.
 * The gateway re-reads the run and the membership on every call, so a
 * cancelled run or a removed member stops working immediately rather than when
 * the token expires.
 *
 * Node `crypto` only and no database import, so the eve bundle can load it.
 */

export const GATEWAY_AUDIENCE = "polymath-gateway";
export const GATEWAY_TOKEN_TTL_SECONDS = 60;
const MIN_SECRET_LENGTH = 32;
/** Tolerated clock difference between eve and the gateway, in seconds. */
const CLOCK_SKEW_SECONDS = 5;

export type GatewayClaims = {
  runId: string;
  userId: string;
  workspaceId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Payload = {
  rid: string;
  uid: string;
  wid: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
};

/** The shared secret, or null when it is missing or too short to trust. */
export function gatewaySecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.EVE_GATEWAY_SECRET?.trim();
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

const encode = (value: string | Buffer) => Buffer.from(value).toString("base64url");
const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest();

export function signGatewayToken(
  claims: GatewayClaims,
  options: { secret: string; now?: Date; ttlSeconds?: number },
): string {
  if (options.secret.length < MIN_SECRET_LENGTH) throw new Error("EVE_GATEWAY_SECRET is too short.");
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const ttl = Math.min(options.ttlSeconds ?? GATEWAY_TOKEN_TTL_SECONDS, GATEWAY_TOKEN_TTL_SECONDS);
  const payload: Payload = {
    rid: claims.runId,
    uid: claims.userId,
    wid: claims.workspaceId,
    aud: GATEWAY_AUDIENCE,
    iat,
    exp: iat + ttl,
    jti: randomUUID(),
  };
  const body = `v1.${encode(JSON.stringify(payload))}`;
  return `${body}.${encode(sign(options.secret, body))}`;
}

/** Claims when the token is genuine, for this audience, and unexpired; otherwise null and no reason. */
export function verifyGatewayToken(
  token: string,
  options: { secret: string; now?: Date },
): GatewayClaims | null {
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
  if (payload.aud !== GATEWAY_AUDIENCE) return null;
  if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat)) return null;
  if (payload.exp <= now - CLOCK_SKEW_SECONDS) return null;
  if (payload.iat > now + CLOCK_SKEW_SECONDS) return null;
  if (payload.exp - payload.iat > GATEWAY_TOKEN_TTL_SECONDS) return null;
  if (typeof payload.rid !== "string" || typeof payload.uid !== "string" || typeof payload.wid !== "string") {
    return null;
  }
  // A correctly signed but non-UUID claim would reach Postgres and throw
  // 22P02 out of the handler; a malformed token is an authentication failure,
  // not a server error.
  if (!UUID.test(payload.rid) || !UUID.test(payload.wid)) return null;
  return { runId: payload.rid, userId: payload.uid, workspaceId: payload.wid };
}
