import type { InspectedSkill } from "@/domains/skills/manifest";

/*
 * What the Add skill form and the inspect action agree on. Kept out of
 * `actions.ts` because a "use server" module may only export async functions,
 * and the client needs the shape to type what it renders.
 *
 * The body and files are deliberately not sent to the browser: the form shows
 * what a package is, and install re-reads the source at the pinned revision.
 * Shipping 512 KB of procedure text into a client island to display a filename
 * would be a payload nobody reads.
 */

export type DiscoveredSkill = Pick<
  InspectedSkill,
  "slug" | "name" | "description" | "warnings"
> & {
  fileCount: number;
  /** The folder inside the source; the install action matches on it. */
  sourcePath: string;
};

export type InspectAction =
  | {
      ok: true;
      sourceKind: "github" | "local";
      sourceRef: string;
      revision: string;
      skills: DiscoveredSkill[];
      warnings: string[];
    }
  | { ok: false; error: string };

export type InstallAction =
  | { ok: true; skillId: string; created: boolean }
  | { ok: false; error: string };

export type SkillWriteAction = { ok: true } | { ok: false; error: string };
