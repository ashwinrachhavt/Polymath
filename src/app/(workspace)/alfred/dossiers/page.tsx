import { connection } from "next/server";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { getAuthContext } from "@/lib/auth";
import { getDossierDetail, listAttachableDocuments, listDossiers } from "@/domains/knowledge/dossiers";
import { CreateDossierForm } from "./create-dossier-form";
import { GenerateForm } from "./generate-form";

export const metadata = { title: "Dossiers · Axiom" };

/*
 * The dossier screen: the workspace's dossiers, the documents each one holds,
 * and Studio Generate bound to a dossier. All of it reads Neon; nothing here
 * is the browser preview.
 */
export default async function DossiersPage({
  searchParams,
}: {
  searchParams: Promise<{ dossier?: string }>;
}) {
  await connection();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Dossiers" purpose="Named sets of documents an agent works inside." />
        <div className="px-4 py-5 md:px-6">
          <EmptyState
            title="Dossier storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to create dossiers and generate from them."
          />
        </div>
      </>
    );
  }
  const auth = await getAuthContext();
  const params = await searchParams;
  const [dossiers, attachable, detail] = await Promise.all([
    listDossiers(auth),
    listAttachableDocuments(auth),
    params.dossier ? getDossierDetail(auth, params.dossier) : Promise.resolve(null),
  ]);

  return (
    <>
      <PageHeader title="Dossiers" purpose="Named sets of documents an agent works inside." />
      <div className="flex flex-col gap-8 px-4 py-5 md:px-6">
        <Section title="Your dossiers" description="A dossier scopes search and generation to the documents pinned inside it.">
          {dossiers.length === 0 ? (
            <EmptyState
              title="No dossiers yet"
              description="Create one below, attach the documents it should cover, then generate a draft that stays inside those documents."
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {dossiers.map((dossier) => (
                <li key={dossier.id}>
                  <a
                    href={`/alfred/dossiers?dossier=${dossier.id}`}
                    className={`flex items-baseline gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent ${detail?.id === dossier.id ? "bg-accent" : ""}`}
                  >
                    <span className="font-medium">{dossier.title}</span>
                    <span className="text-muted-foreground">
                      {dossier.documentCount} {dossier.documentCount === 1 ? "document" : "documents"}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {detail ? (
          <Section title={detail.title} description="The documents this dossier holds, each pinned at the version it was attached at.">
            {detail.documents.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">No documents yet. Create a dossier with documents, or ask Alfred to attach them.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {detail.documents.map((doc) => (
                  <li key={doc.id} className="flex items-baseline gap-2 px-2 py-1 text-[13px]">
                    <span>{doc.title}</span>
                    <span className="text-muted-foreground">{doc.mimeType ?? "unfiled"}</span>
                  </li>
                ))}
              </ul>
            )}
            <Section title="Generate a draft" description="Starts a run that reads only this dossier. The result is a draft you save or discard; nothing publishes.">
              <GenerateForm dossierId={detail.id} />
            </Section>
          </Section>
        ) : null}

        <Section title="New dossier" description="Pick the documents it should cover. You can attach more later.">
          <CreateDossierForm documents={attachable} />
        </Section>
      </div>
    </>
  );
}
