import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Knowledge · Axiom" };

/*
 * Notes, documents, sources, and flashcards. Search is the reason this screen
 * exists, so the kinds of retrieval are stated rather than implied: exact,
 * full text, and semantic, always filtered by workspace and source version.
 */
export default function KnowledgePage() {
  return (
    <>
      <PageHeader
        title="Knowledge"
        purpose="Write, retrieve, and connect."
        actions={
          <>
            <Button variant="outline" disabled>
              Import
            </Button>
            <Button disabled>New note</Button>
          </>
        }
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section title="Search" description="Exact, full text, and semantic — one box.">
          <form className="flex gap-2">
            <label htmlFor="search" className="sr-only">
              Search knowledge
            </label>
            <input
              id="search"
              type="search"
              disabled
              placeholder="Search notes, documents, sources, and claims"
              className="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-3 py-2 text-[13px] outline-none focus-visible:ring-3 disabled:opacity-60"
            />
            <Button type="button" disabled>
              Search
            </Button>
          </form>
        </Section>

        <Section title="Notes and documents" description="Versions are immutable, so an approved draft stays approved.">
          <EmptyState
            title="Nothing written yet"
            description="Notes, imported files, extracted text, and Alfred's output all live here as versioned artifacts."
          />
        </Section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Sources" description="Where a claim came from, with the exact passage.">
            <EmptyState
              title="No sources yet"
              description="Pages, files, and messages become sources once something cites them."
            />
          </Section>

          <Section title="Learning" description="Separate from writing: what you are trying to retain.">
            <EmptyState
              title="No cards yet"
              description="Flashcards and quizzes are proposed from your own material, and only scheduled once you approve them."
              action={<Badge variant="outline"><Readout>0 due</Readout></Badge>}
            />
          </Section>
        </div>
      </div>
    </>
  );
}
