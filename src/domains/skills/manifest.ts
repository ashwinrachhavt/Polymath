import type { SkillFile } from "./schema";

/*
 * What an inspection produces, before anything is stored. The install command
 * takes this shape plus the source coordinates it was inspected from, so the
 * producer (Task 2's inspectSource) and consumers (the install action) agree on
 * one contract instead of passing parallel argument lists.
 */
export type InspectedSkill = {
  name: string;
  slug: string;
  description: string;
  body: string;
  files: SkillFile[];
  warnings: string[];
  contentHash: string;
  /**
   * The folder inside the source the package was read from. Set by
   * `extractPackages`, and part of the install identity. Optional because a
   * test may assemble an `InspectedSkill` by hand; the install action refuses
   * one without it rather than inventing a path.
   */
  sourcePath?: string;
};
