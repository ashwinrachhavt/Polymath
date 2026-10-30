import { redirect } from "next/navigation";

/*
 * The zettel/sitting surface is retired: creation is one loop from Inbox, and
 * ideas live at /polymath/ideas. Every old URL lands there - the collection,
 * a sitting's session list, a session's deep link (/session/<id>), and the
 * "new sitting" form - so a saved bookmark or a shared sitting link resolves
 * to the successor screen instead of a 404. This catch-all is what covers the
 * dynamic segments featureRoutes cannot match.
 */
export default async function ZettelsRedirect() {
  redirect("/polymath/ideas");
}
