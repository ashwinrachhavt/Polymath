import { authedHandler } from "@/lib/auth";
import { listDrafts } from "@/domains/knowledge/studio";

/* GET /api/v1/drafts — the workspace's open generated drafts, newest first.
 *
 * The old POST (run output -> draft artifact) is gone: saving a generated
 * draft is a Studio-domain operation exercised through saveGeneratedDraft,
 * and no surface ever called this route's POST. */
export const GET = authedHandler(async (auth) => Response.json({ drafts: await listDrafts(auth) }));
