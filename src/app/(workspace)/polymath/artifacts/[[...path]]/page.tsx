import { redirect } from "next/navigation";

/*
 * The second artifacts reader merged into /artifacts. Old URLs still resolve:
 * the list lands on the gallery, and /polymath/artifacts/<id> (the wiki page
 * reader) opens that artifact's detail, which renders wiki pages too.
 */
export default async function PolymathArtifactsRedirect({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  const [artifactId] = path;
  redirect(artifactId ? `/artifacts/${encodeURIComponent(artifactId)}` : "/artifacts");
}
