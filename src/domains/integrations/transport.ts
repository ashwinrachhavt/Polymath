import { executeComposioRead } from "./composio";

/*
 * The transport seam. Every gateway read tool talks to a provider through this
 * interface and nothing else, so the set of things a read can do is fixed by a
 * type rather than by review:
 *  - reads only. There is no write method, and the method union is GET/HEAD. A
 *    write is not refused at runtime here; it is unrepresentable.
 *  - no retry. A retry inside the transport hides a provider failure from the
 *    user and multiplies spend; the caller decides.
 *  - the status survives. The gateway distinguishes a revoked credential (401)
 *    from a provider outage (500), so a failed read carries the HTTP status the
 *    provider answered with, not just a message.
 */

export type TransportRequest = {
  connectedAccountId: string;
  /** Absolute https URL of the provider endpoint. */
  endpoint: string;
  method: "GET" | "HEAD";
  query?: Record<string, string>;
  headers?: Record<string, string>;
};

export type TransportResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; code: "not_configured" | "provider_error"; status?: number; message: string };

export interface Transport {
  read(request: TransportRequest): Promise<TransportResult>;
}

export const composioTransport: Transport = {
  async read(request) {
    const result = await executeComposioRead({
      connectedAccountId: request.connectedAccountId,
      endpoint: request.endpoint,
      method: request.method,
      query: request.query,
      headers: request.headers,
    });
    if (result.ok) {
      // executeComposioRead only succeeds on a 2xx proxy response. It does not
      // surface the exact code, and the gateway only needs "success" here; 200
      // is the only status that matters to it.
      return { ok: true, status: 200, data: result.data };
    }
    if (result.code === "not_configured") {
      return { ok: false, code: "not_configured", message: result.message };
    }
    // `read_only_violation` cannot come back from the call above: the request's
    // method type is GET/HEAD, and executeComposioRead would throw rather than
    // return. If it ever does, it is a provider_error at this seam.
    return {
      ok: false,
      code: "provider_error",
      status: result.status,
      message: result.message,
    };
  },
};
