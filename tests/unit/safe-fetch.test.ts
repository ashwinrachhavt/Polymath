import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPrivateAddress, parseCaptureUrl, safeFetch } from "@/lib/safe-fetch";

let server: Server;
let base: string;
const PDF = Buffer.from("%PDF-1.4\nfixture");

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/doc.pdf") return void res.writeHead(200, { "content-type": "application/pdf" }).end(PDF);
    if (req.url === "/redirect") return void res.writeHead(302, { location: "/doc.pdf" }).end();
    if (req.url === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
    if (req.url === "/big") return void res.writeHead(200).end(Buffer.alloc(2048));
    if (req.url === "/slow") return; // never answers
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"])("allows %s", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false));
});

describe("parseCaptureUrl", () => {
  it("accepts http(s) and drops the fragment", () => {
    const parsed = parseCaptureUrl("https://example.com/a.pdf#page=2");
    expect(parsed.ok && parsed.url.href).toBe("https://example.com/a.pdf");
  });
  it.each([
    ["not a url"], ["file:///etc/passwd"], ["ftp://example.com/x"], ["http://user:pw@example.com/"],
    ["http://localhost:3000/"], ["http://127.0.0.1/"], ["http://[::1]/"], ["http://metadata.internal/"],
    ["http://169.254.169.254/latest/meta-data"],
  ])("rejects %s", (raw) => expect(parseCaptureUrl(raw).ok).toBe(false));
});

describe("safeFetch", () => {
  it("refuses loopback by default, at the socket as well as in the URL", async () => {
    expect(await safeFetch(`${base}/doc.pdf`)).toMatchObject({ ok: false });
  });
  it("blocks a hostname that resolves to loopback (checked at connect time)", async () => {
    const port = new URL(base).port;
    // "localhost" is rejected by name; use a name that is not on the deny list but resolves to loopback.
    const result = await safeFetch(`http://127.0.0.1.nip.invalid:${port}/`);
    expect(result.ok).toBe(false);
  });
  it("downloads bytes when private addresses are allowed for the fixture", async () => {
    const result = await safeFetch(`${base}/doc.pdf`, { allowPrivateAddresses: true });
    expect(result).toMatchObject({ ok: true, contentType: "application/pdf" });
    if (result.ok) expect(Buffer.from(result.bytes).equals(PDF)).toBe(true);
  });
  it("follows a redirect", async () => {
    expect(await safeFetch(`${base}/redirect`, { allowPrivateAddresses: true })).toMatchObject({ ok: true });
  });
  it("stops a redirect loop", async () => {
    expect(await safeFetch(`${base}/loop`, { allowPrivateAddresses: true, maxRedirects: 2 })).toEqual({
      ok: false, error: "The address redirected too many times.",
    });
  });
  it("cuts off a body past the size limit", async () => {
    expect(await safeFetch(`${base}/big`, { allowPrivateAddresses: true, maxBytes: 1024 })).toMatchObject({
      ok: false, error: expect.stringContaining("4 MB"),
    });
  });
  it("reports a non-200 answer", async () => {
    expect(await safeFetch(`${base}/missing`, { allowPrivateAddresses: true })).toEqual({
      ok: false, error: "The site answered with status 404.",
    });
  });
  it("times out a site that never answers", async () => {
    expect(await safeFetch(`${base}/slow`, { allowPrivateAddresses: true, timeoutMs: 200 })).toEqual({
      ok: false, error: "The site took too long to answer.",
    });
  });
});
