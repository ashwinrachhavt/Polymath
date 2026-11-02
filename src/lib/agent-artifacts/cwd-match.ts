/*
 * Where a parsed session belongs (Workbench D3): agents record the folder they
 * ran in (`cwd`), and a project claims a folder (notebooks.repo_path). The
 * match is the attachment between the two — pure, so the project-page query
 * and the brief route share one definition and the tests need no database.
 */

/**
 * Whether a session's transcript cwd belongs to a project whose code lives at
 * `repoPath`. Paths are compared as the agents write them: normalized for
 * trailing slashes, case-preserved (the user's own filesystem spelling), and
 * a session belongs when its cwd IS the repo path or nested under it — agents
 * run from subdirectories of the repo they were opened in.
 */
export function cwdMatchesProjectRoot(sessionCwd: string, repoPath: string): boolean {
  const session = sessionCwd.trim().replace(/\/+$/, "");
  const root = repoPath.trim().replace(/\/+$/, "");
  if (session === "" || root === "") return false;
  if (session === root) return true;
  // A bare prefix match would claim /home/me/repo-evil for /home/me/repo;
  // the boundary must be a path separator.
  return session.startsWith(`${root}/`);
}
