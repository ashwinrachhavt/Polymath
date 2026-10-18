import Contacts from "@/components/products/command-center/contacts";
import { ImportButton } from "./import-button";

export const metadata = { title: "Relationships · Axiom" };

/*
 * The contacts surface is still the browser-preview store (PR #13). The
 * import writes canonical people/organizations in Postgres, so it sits here
 * as a separate strip rather than pretending the two lists are one screen:
 * merging them is ASH-135 item 2 ("retire the preview store per domain"),
 * and a half-merge would show the owner two different contact sets with no
 * way to tell which is real.
 */
export default function RelationshipsPage() {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
          Importing writes people and organizations to the database. The list
          below is still the browser preview until the domains are unified.
        </p>
        <ImportButton />
      </div>
      <Contacts title="Relationships" />
    </>
  );
}
