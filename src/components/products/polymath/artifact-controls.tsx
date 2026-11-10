import type { Artifact } from "@/components/workspace/types";

/*
 * Where a browser-preview artifact link points. The /apps preview screens are
 * retired; these addresses now redirect to the real screen for each kind
 * (src/lib/preview-redirects.ts), and a note keeps its ?id= deep link.
 */
export function artifactHref(record: Pick<Artifact, "id" | "kind" | "tags">) {
  const slug = record.tags.includes("Blog draft")
    ? "blogs"
    : {
        source: "library",
        document: "library",
        note: "notebook",
        zettel: "zettels",
        dossier: "dossiers",
        canvas: "canvas",
      }[record.kind];
  return `/apps/polymath/${slug}?id=${encodeURIComponent(record.id)}`;
}
