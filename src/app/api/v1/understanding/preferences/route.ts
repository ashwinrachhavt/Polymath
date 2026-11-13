import { authedHandler } from "@/lib/auth";
import { requireRole, requireScope } from "@/lib/auth/guards";
import { actingAuth } from "@/domains/understanding/actor";
import { getUnderstandingPreferences } from "@/domains/understanding/preferences";
import { understandingProblem } from "../problems";

/* GET /api/v1/understanding/preferences - the switches the plugin's hooks and questions follow. Set in Settings, never here. */
export const GET = authedHandler(async (auth) => {
  requireRole(auth, "viewer");
  requireScope(auth, "understanding:read");
  try {
    const { version: _version, ...preferences } = await getUnderstandingPreferences(await actingAuth(auth));
    return Response.json(preferences);
  } catch (error) {
    return understandingProblem(error);
  }
});
