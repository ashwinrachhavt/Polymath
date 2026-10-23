import { z } from "zod";
import type { Transport } from "@/domains/integrations/transport";
import type { ReadFailure } from "./github";
import { malformedResponse, transportFailure } from "./failures";

/*
 * LinkedIn reads. One honest tool: the authenticated member's profile via the
 * OpenID userinfo endpoint. Reading the member's own feed or posts is a
 * restricted LinkedIn permission (r_member_social is closed; the marketing
 * APIs are partner-gated), so no list/search tool ships - the tier and the
 * card say exactly what the connection can do.
 */

const API = "https://api.linkedin.com";

const profileSchema = z.object({
  sub: z.string(),
  name: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  picture: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  locale: z.union([z.string(), z.object({ country: z.string().optional(), language: z.string().optional() })]).optional(),
});

export type LinkedInProfile = {
  id: string;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  picture: string | null;
  email: string | null;
};

export async function getLinkedInProfile(
  transport: Transport,
  input: { connectedAccountId: string },
): Promise<{ ok: true; profile: LinkedInProfile } | ReadFailure> {
  const result = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${API}/v2/userinfo`,
    method: "GET",
  });
  if (!result.ok) return transportFailure(result, "LinkedIn");
  const parsed = profileSchema.safeParse(result.data);
  if (!parsed.success) return malformedResponse("LinkedIn", "profile");
  return {
    ok: true,
    profile: {
      id: parsed.data.sub,
      name: parsed.data.name ?? null,
      givenName: parsed.data.given_name ?? null,
      familyName: parsed.data.family_name ?? null,
      picture: parsed.data.picture ?? null,
      email: parsed.data.email ?? null,
    },
  };
}
