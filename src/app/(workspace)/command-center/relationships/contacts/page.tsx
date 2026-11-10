import { permanentRedirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/*
 * Retired: the contact workspace folded into People. Bookmarked /contacts and
 * /contacts?id=<contactId> land on the People table or that contact's detail.
 */
async function ContactsRedirect({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const id = Array.isArray(query.id) ? query.id[0] : query.id;
  return permanentRedirect(
    id ? `/command-center/relationships/people?id=${encodeURIComponent(id)}` : "/command-center/relationships/people",
  );
}

export default function ContactsPage({ searchParams }: { searchParams: SearchParams }) {
  return <ContactsRedirect searchParams={searchParams} />;
}
