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

/*
 * Shell-read tags (page-render speedup): the workspace layout's three chrome
 * reads are cached wrappers, so the mutations that change what they show must
 * expire them by tag. prefs is scoped to workspace+user (one row per pair);
 * the feed is workspace-scoped chrome; the switcher is user-scoped (a
 * membership spans workspaces) and the invitation rows the switcher filters
 * are addressed to an email, so create/revoke invalidates that exact mailbox.
 */
export const prefsTag = (auth: AuthContext): string => `prefs:${auth.workspaceId}:${auth.userId}`;
export const feedTag = (auth: AuthContext): string => `feed:${auth.workspaceId}`;
export const workspacesTag = (userId: string): string => `workspaces:${userId}`;
export const invitationsTag = (email: string): string => `invitations:${email.trim().toLowerCase()}`;
export const sessionEmailTag = (key: string): string => `session-email:${key}`;
