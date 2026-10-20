/*
 * Live smoke over every configured extraction provider, local only. Never
 * part of pnpm check; CI stays fixture-only (agents/coding.md).
 *
 *   tsx --env-file=.env scripts/smoke/extraction-providers.mts [path/to.pdf]
 *
 * With no argument it generates a small one-page PDF with a text layer in
 * /tmp. Each configured provider (docling via DOCLING_SERVE_URL, Reducto via
 * REDUCTO_API_KEY, LlamaParse via LLAMAPARSE_API_KEY, and the in-process
 * text-layer reader) gets the same bytes; the script prints extractor id,
 * page count, char count and the first 200 cleaned chars. Exit 1 when a
 * configured provider fails. Importing this module is side-effect free.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDoclingDockerProvider } from "../../src/integrations/extraction/docling-docker";
import { createLlamaParseProvider } from "../../src/integrations/extraction/llamaparse";
import { createReductoProvider } from "../../src/integrations/extraction/reducto";
import { createPdfTextLayerProvider } from "../../src/integrations/extraction/pdf-text-layer";
import type { ExtractionProvider } from "../../src/integrations/extraction/provider";
import { samplePdf } from "../../tests/helpers/sample-pdf";

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

export async function runSmoke(): Promise<number> {
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
  return failures;
}

/** Importing this module runs nothing: only direct execution starts the smoke. */
const invokedDirectly = process.argv[1]?.endsWith("extraction-providers.mts");
if (invokedDirectly) {
  const failures = await runSmoke();
  process.exit(failures ? 1 : 0);
}