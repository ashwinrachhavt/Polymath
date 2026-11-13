import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export async function defaultExec(file, args, { cwd }) {
  const { stdout } = await execFileAsync(file, args, { cwd, maxBuffer: MAX_GIT_OUTPUT_BYTES });
  return stdout;
}

export function normalizeRepo(remoteUrl) {
  const match = remoteUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .match(/[:/]([^/:]+\/[^/:]+)$/);
  return match ? match[1] : null;
}

export async function repoName(exec, cwd) {
  const remote = await exec("git", ["remote", "get-url", "origin"], { cwd }).catch(() => "");
  const fromRemote = normalizeRepo(remote);
  if (fromRemote) return fromRemote;
  return basename((await exec("git", ["rev-parse", "--show-toplevel"], { cwd })).trim());
}

export async function resolveCommit(exec, cwd, rev) {
  return (await exec("git", ["rev-parse", "--verify", `${rev}^{commit}`], { cwd })).trim();
}
