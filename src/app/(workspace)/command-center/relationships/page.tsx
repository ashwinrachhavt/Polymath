import { redirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/*
 * The Relationships index has no surface of its own: People is the table the
 * owner lands on, and the CRM contact workspace (detail, follow-ups,
 * correspondence) opens from People with ?id=. Deep links to ?id= keep working by
 * carrying the selection across.
 */
async function RelationshipsIndex({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const id = Array.isArray(query.id) ? query.id[0] : query.id;
  return redirect(
    id ? `/command-center/relationships/people?id=${encodeURIComponent(id)}` : "/command-center/relationships/people",
  );
}

export default function RelationshipsIndexPage({ searchParams }: { searchParams: SearchParams }) {
  return <RelationshipsIndex searchParams={searchParams} />;
}
