// Temporary headless probe for the flicker investigation. Delete after use.
import { chromium } from "@playwright/test";

const [, , path = "/polymath/notes", mode = "none", secs = "15"] = process.argv;
const base = "http://localhost:3000";

function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", kid: "ins_bogus", typ: "JWT" })}.${b64(payload)}.c2ln`;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const now = Math.floor(Date.now() / 1000);
if (mode === "garbage") {
  await context.addCookies([
    { name: "__session", value: "garbage.value.here", url: base },
    { name: "__client_uat", value: String(now - 3600), url: base },
  ]);
} else if (mode === "expired") {
  const jwt = fakeJwt({
    sub: "user_x",
    sid: "sess_x",
    iss: "https://other-instance.clerk.accounts.dev",
    exp: now - 600,
    iat: now - 1200,
    nbf: now - 1200,
  });
  await context.addCookies([
    { name: "__session", value: jwt, url: base },
    { name: "__client_uat", value: String(now - 1200), url: base },
    { name: "__clerk_db_jwt", value: "dvb_bogus", url: base },
  ]);
}
const page = await context.newPage();
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
const navs = [];
const reqs = [];
page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) {
    navs.push(f.url());
    console.log(`${ts()} NAV ${f.url()}`);
  }
});
page.on("request", (r) => {
  const u = new URL(r.url());
  const isRsc = r.headers()["rsc"] === "1";
  if (u.host.includes("localhost") && !u.pathname.startsWith("/_next/static") && !u.pathname.startsWith("/__nextjs")) {
    reqs.push(`${r.method()} ${u.pathname}${isRsc ? " [RSC]" : ""}`);
    if (process.env.VERBOSE)
      console.log(
        `${ts()} REQ ${r.method()} ${u.pathname}${u.search.slice(0, 80)}${isRsc ? " [RSC]" : ""} ${r.resourceType()}`,
      );
  } else if (!u.host.includes("localhost") && process.env.VERBOSE) {
    console.log(`${ts()} EXT ${r.method()} ${u.host}${u.pathname}`);
  }
});
page.on("response", (r) => {
  if (r.status() >= 300 && r.status() < 400)
    console.log(`${ts()} ${r.status()} ${r.url()} -> ${r.headers()["location"]}`);
});
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning" || process.env.VERBOSE)
    console.log(`${ts()} CONSOLE.${m.type()} ${m.text().slice(0, 300)}`);
});
page.on("websocket", (ws) => {
  console.log(`${ts()} WS open ${ws.url()}`);
  ws.on("framereceived", (f) => {
    const t =
      typeof f.payload === "string"
        ? f.payload
        : "<bin>" +
          Buffer.from(f.payload)
            .toString("latin1")
            .replace(/[^\x20-\x7e]/g, ".")
            .slice(0, 300);
    if (!/"(ping|turbopack-connected)"/.test(t) || process.env.VERBOSE) console.log(`${ts()} WS<- ${t.slice(0, 400)}`);
  });
  ws.on("framesent", (f) => {
    if (process.env.WSOUT) console.log(`${ts()} WS-> ${String(f.payload).slice(0, 300)}`);
  });
});
page.on("pageerror", (e) => console.log(`${ts()} PAGEERROR ${e.message.slice(0, 300)}`));

try {
  await page.goto(base + path, { waitUntil: "domcontentloaded", timeout: 60000 });
} catch (e) {
  console.log("goto error", e.message);
}
await page.waitForTimeout(Number(secs) * 1000);
const counts = {};
for (const r of reqs) counts[r] = (counts[r] ?? 0) + 1;
console.log(`\nFINAL URL ${page.url()}`);
console.log(`navigations=${navs.length} requests=${reqs.length}`);
console.log(JSON.stringify(counts, null, 1));
console.log("cookies", (await context.cookies()).map((c) => c.name).join(","));
await browser.close();
