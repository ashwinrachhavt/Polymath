import type { AuthContext } from "@/domains/identity/resolve";

/*
 * Cache tags for the cached hero-route reads ("use cache"). Every tag carries
 * the workspace id, so one workspace's writes never invalidate another's
 * entries. Server actions call updateTag on each surface their writes change;
 * reads assign the tags with cacheTag. See src/app/(workspace)/briefing|inbox
 * |neuralflow/work data.ts for the cached read wrappers.
 */
export const tasksTag = (auth: AuthContext): string => `tasks:${auth.workspaceId}`;
export const capturesTag = (auth: AuthContext): string => `captures:${auth.workspaceId}`;
export const focusTag = (auth: AuthContext): string => `focus:${auth.workspaceId}`;
