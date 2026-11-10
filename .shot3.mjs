import { chromium } from "@playwright/test";
const out = process.argv[2];
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
await p.goto("http://localhost:3000/polymath/notes", { waitUntil: "networkidle", timeout: 180000 });
await p.waitForTimeout(1500);
await p.screenshot({ path: `${out}/font-notes.png` });
const fonts = await p.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).fontFamily.slice(0, 60) : null;
  };
  return { body: pick("body"), prose: pick(".prose-reading"), h1: pick("h1"), readout: pick(".readout") };
});
console.log(JSON.stringify(fonts));
await b.close();
