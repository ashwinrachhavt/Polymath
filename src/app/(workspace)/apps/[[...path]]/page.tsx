import { redirect } from "next/navigation";
import type { RawSearchParams } from "@/lib/list-params";
import { previewRedirectTarget } from "@/lib/preview-redirects";

/*
 * The browser-local preview tools under /apps are retired. Every old address
 * (a bookmark, a link saved in a note, the /apps/alfred rename bridge) lands
 * on the real screen that does the same job, or on /polymath when none does.
 */
export default async function PreviewRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const [{ path = [] }, query] = await Promise.all([params, searchParams]);
  redirect(previewRedirectTarget(path, query));
}
