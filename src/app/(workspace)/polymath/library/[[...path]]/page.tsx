import { redirect } from "next/navigation";

/*
 * The reading library merged into the Vault (/polymath/knowledge). Old URLs
 * still resolve: the list lands on the Vault, and /polymath/library/<id> opens
 * that document's detail in the Vault.
 */
export default async function LibraryRedirect({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  const [documentId] = path;
  redirect(documentId ? `/polymath/knowledge?doc=${encodeURIComponent(documentId)}` : "/polymath/knowledge");
}
