import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { MAX_UPLOAD_BYTES } from "./file-validation";

/*
 * Server-side fetch of a URL the user typed. The server is the one making the
 * request, so the URL decides what network the server touches: it must never
 * reach loopback, a private range, or a cloud metadata address. The check runs
 * on the address the socket actually connects to (inside `lookup`), not on a
 * name resolved earlier, so a name that resolves differently the second time
 * (DNS rebinding) is refused too. Redirects are followed by hand and every hop
 * is checked again. The body is streamed and cut off at the upload ceiling.
 */

/**
 * `error` is the sentence shown to a person. The optional fields exist for
 * callers that must branch on why a request failed (a missing repository and a
 * private one are different messages); they are only filled when
 * `failureDetails` is set, so the plain result stays exactly two fields.
 */
export type SafeFetchResult =
  | { ok: true; bytes: Uint8Array; finalUrl: string; contentType: string | null }
  | {
      ok: false;
      error: string;
      /** HTTP status of the answer that failed, when there was one. */
      status?: number;
      timedOut?: true;
      rateLimited?: true;
      tooLarge?: true;
    };

export type SafeFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Extra request headers, merged over the defaults (a caller may need an API's media type). */
  headers?: Record<string, string>;
  /** Fill the machine-readable failure fields on the error result. */
  failureDetails?: boolean;
  /** Tests only: let the loopback fixture server through. Never set in app code. */
  allowPrivateAddresses?: boolean;
};

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, includes cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast and reserved
  );
}

/** True for any address a user-supplied URL must not reach. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return ipv4Private(ip);
  if (version !== 6) return true;
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return (
    lower === "::" || lower === "::1" ||
    lower.startsWith("fc") || lower.startsWith("fd") || // unique local
    /^fe[89ab]/.test(lower) || // link-local
    lower.startsWith("ff") // multicast
  );
}

/** Parses and screens a URL before any network call. */
export function parseCaptureUrl(raw: string, allowPrivate = false): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "That does not look like a web address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http and https addresses can be captured." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Addresses with a username or password are not supported." };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (allowPrivate) {
    url.hash = "";
    return { ok: true, url };
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return { ok: false, error: "That address points at this server's own network." };
  }
  if (isIP(host) && isPrivateAddress(host)) {
    return { ok: false, error: "That address points at this server's own network." };
  }
  url.hash = "";
  return { ok: true, url };
}

const TRACKING_PARAMS = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src)$/i;

/**
 * The one form a captured address is stored and matched in, so the same page
 * pasted twice never becomes two Knowledge rows: no fragment, no tracking
 * parameters, sorted query, no trailing slash on a path, default port dropped.
 */
export function canonicalCaptureUrl(input: URL): string {
  const url = new URL(input.href);
  url.hash = "";
  const kept = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.test(key));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

type OnceFailure = {
  kind: "error";
  error: string;
  status?: number;
  timedOut?: true;
  rateLimited?: true;
  tooLarge?: true;
};

function once(url: URL, options: Required<SafeFetchOptions>): Promise<
  | { kind: "body"; bytes: Uint8Array; contentType: string | null }
  | { kind: "redirect"; location: string }
  | OnceFailure
> {
  return new Promise((resolve) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/pdf,image/png,image/jpeg;q=0.9,*/*;q=0.1",
          "user-agent": "PolymathCapture/1.0",
          ...options.headers,
        },
        timeout: options.timeoutMs,
        lookup: (hostname, lookupOptions, callback) => {
          dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
            if (error) return callback(error, "", 4);
            const list = addresses as unknown as Array<{ address: string; family: number }>;
            const blocked = !options.allowPrivateAddresses && list.some((a) => isPrivateAddress(a.address));
            if (blocked || list.length === 0) {
              return callback(new Error("blocked_address"), "", 4);
            }
            if ((lookupOptions as { all?: boolean }).all) {
              return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
            }
            callback(null, list[0].address, list[0].family);
          });
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          return resolve({ kind: "redirect", location: response.headers.location });
        }
        if (status < 200 || status >= 300) {
          // GitHub answers a throttled request with 403 and `x-ratelimit-remaining: 0`;
          // a private repository is a plain 403. Reading the header keeps the two
          // apart without guessing from a body we do not download.
          const limited =
            status === 429 ||
            (status === 403 && response.headers["x-ratelimit-remaining"] === "0");
          response.resume();
          return resolve(
            options.failureDetails
              ? { kind: "error", error: `The site answered with status ${status}.`, status, ...(limited ? { rateLimited: true as const } : {}) }
              : { kind: "error", error: `The site answered with status ${status}.` },
          );
        }
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy();
          return resolve(
            options.failureDetails
              ? { kind: "error", error: "That file is larger than the 4 MB limit.", tooLarge: true }
              : { kind: "error", error: "That file is larger than the 4 MB limit." },
          );
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy();
            return resolve(
              options.failureDetails
                ? { kind: "error", error: "That file is larger than the 4 MB limit.", tooLarge: true }
                : { kind: "error", error: "That file is larger than the 4 MB limit." },
            );
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            kind: "body",
            bytes: new Uint8Array(Buffer.concat(chunks)),
            contentType: response.headers["content-type"] ?? null,
          }),
        );
        response.on("error", () => resolve({ kind: "error", error: "The download was interrupted." }));
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(
        options.failureDetails
          ? { kind: "error", error: "The site took too long to answer.", timedOut: true }
          : { kind: "error", error: "The site took too long to answer." },
      );
    });
    request.on("error", (error) =>
      resolve({
        kind: "error",
        error: error.message === "blocked_address"
          ? "That address points at this server's own network."
          : "The site could not be reached.",
      }),
    );
    request.end();
  });
}

export async function safeFetch(rawUrl: string, input: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const options: Required<SafeFetchOptions> = {
    timeoutMs: input.timeoutMs ?? 10_000,
    maxBytes: input.maxBytes ?? MAX_UPLOAD_BYTES,
    maxRedirects: input.maxRedirects ?? 3,
    headers: input.headers ?? {},
    failureDetails: input.failureDetails ?? false,
    allowPrivateAddresses: input.allowPrivateAddresses ?? false,
  };
  let current = parseCaptureUrl(rawUrl, options.allowPrivateAddresses);
  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    if (!current.ok) return current;
    const result = await once(current.url, options);
    if (result.kind === "error") {
      if (!options.failureDetails) return { ok: false, error: result.error };
      return {
        ok: false,
        error: result.error,
        ...(result.status !== undefined ? { status: result.status } : {}),
        ...(result.timedOut ? { timedOut: true as const } : {}),
        ...(result.rateLimited ? { rateLimited: true as const } : {}),
        ...(result.tooLarge ? { tooLarge: true as const } : {}),
      };
    }
    if (result.kind === "body") {
      return { ok: true, bytes: result.bytes, finalUrl: current.url.href, contentType: result.contentType };
    }
    current = parseCaptureUrl(new URL(result.location, current.url).href, options.allowPrivateAddresses);
  }
  return { ok: false, error: "The address redirected too many times." };
}
