import { redirect } from "next/navigation";
import type { RawSearchParams } from "@/lib/list-params";

/*
 * The Files explorer merged into the Vault (/polymath/knowledge). A deep link
 * carried ?doc=<id> to one document; the Vault reads the same parameter for
 * its document detail, so it is preserved and everything else drops.
 */
export default async function FilesRedirect({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const raw = await searchParams;
  const doc = typeof raw.doc === "string" && raw.doc ? raw.doc : null;
  redirect(doc ? `/polymath/knowledge?doc=${encodeURIComponent(doc)}` : "/polymath/knowledge");
}
