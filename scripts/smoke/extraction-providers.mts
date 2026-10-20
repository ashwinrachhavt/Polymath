/*
 * Live smoke over every configured extraction provider, local only. Never
 * part of pnpm check; CI stays fixture-only (agents/coding.md).
 *
 *   tsx --env-file=.env scripts/smoke/extraction-providers.ts [path/to.pdf]
 *
 * With no argument it generates a small one-page PDF with a text layer in
 * /tmp. Each configured provider (docling via DOCLING_SERVE_URL, Reducto via
 * REDUCTO_API_KEY, LlamaParse via LLAMAPARSE_API_KEY, and the in-process
 * text-layer reader) gets the same bytes; the script prints extractor id,
 * page count, char count and the first 200 cleaned chars. Exit 1 when a
 * configured provider fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDoclingDockerProvider } from "../../src/integrations/extraction/docling-docker";
import { createLlamaParseProvider } from "../../src/integrations/extraction/llamaparse";
import { createReductoProvider } from "../../src/integrations/extraction/reducto";
import { createPdfTextLayerProvider } from "../../src/integrations/extraction/pdf-text-layer";
import type { ExtractionProvider } from "../../src/integrations/extraction/provider";

/** A minimal valid one-page PDF with a text layer (content stream draws "Polymath smoke test"). */
function samplePdf(): Uint8Array {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    "4 0 obj\n<< /Length 58 >>\nstream\nBT /F1 24 Tf 72 700 Td (Polymath smoke test) Tj ET\nendstream\nendobj\n",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

const configured: Array<{ name: string; provider: ExtractionProvider | null }> = [
  {
    name: "docling-serve@local",
    provider: process.env.DOCLING_SERVE_URL
      ? createDoclingDockerProvider(process.env.DOCLING_SERVE_URL)
      : null,
  },
  {
    name: "reducto@hosted",
    provider: process.env.REDUCTO_API_KEY
      ? createReductoProvider(process.env.REDUCTO_API_KEY)
      : null,
  },
  {
    name: "llamaparse@hosted",
    provider: process.env.LLAMAPARSE_API_KEY
      ? createLlamaParseProvider(process.env.LLAMAPARSE_API_KEY)
      : null,
  },
  { name: "pdf-text-layer@local (floor)", provider: createPdfTextLayerProvider() },
];

const argPath = process.argv[2];
let bytes: Uint8Array;
if (argPath) {
  bytes = new Uint8Array(readFileSync(argPath));
} else {
  const path = join(tmpdir(), `polymath-smoke-${Date.now()}.pdf`);
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(path, samplePdf());
  bytes = new Uint8Array(readFileSync(path));
  console.log(`No file argument; generated sample PDF at ${path}`);
}

const input = { bytes, filename: "smoke.pdf", mimeType: "application/pdf" };
let failures = 0;
for (const { name, provider } of configured) {
  if (!provider) {
    console.log(`\n[${name}] not configured; skipped`);
    continue;
  }
  const started = Date.now();
  const result = await provider.extract(input);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.ok) {
    console.log(
      `\n[${name}] OK in ${seconds}s — pages: ${result.pageCount ?? "?"}, chars: ${result.text.length}\n  first 200: ${JSON.stringify(result.text.slice(0, 200))}`,
    );
  } else {
    failures += 1;
    console.log(`\n[${name}] FAILED in ${seconds}s — ${result.error}`);
  }
}
process.exit(failures ? 1 : 0);