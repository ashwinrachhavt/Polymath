import { redirect } from "next/navigation";

/*
 * /polymath/dossiers became /projects (Perplexity-Spaces parity). Every old URL
 * redirects: the list, a dossier, and a dossier's notebook.
 */
export default async function DossiersRedirect({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  const [id, notebook] = path;
  if (id) redirect(notebook === "notebook" ? `/projects/${id}/notebook` : `/projects/${id}`);
  redirect("/projects");
}
