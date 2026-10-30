/*
 * Replace `globalThis.fetch` for the duration of one eval, so the only endpoints
 * the process can reach are the model and the harness's own agent.
 *
 * The stub list is a convention: it only holds for the tools we remembered to
 * list. `stubs.ts` plus `tests/unit/eval-stub-coverage.test.ts` closes that at
 * author time. This guard closes it at run time: if anything in this process
 * reaches the network anyway, the request dies here instead of reading the
 * owner's inbox (the incident recorded in chat-grounding.eval.ts).
 *
 * Scope, stated plainly because it matters: this guards the eval process. The
 * agent itself runs in a worker with its own `globalThis` (eve's
 * `NodeDevelopmentRunner` -> `new Worker(...)`), so a provider client inside a
 * tool would not pass through here. `assertEvalEnvironment` is what stops that
 * path, by refusing to run an eval on a machine that holds a provider key at
 * all. This guard is the second, independent line for everything in-process.
 */

/** The only external host an eval may reach: Gemini, the agent's model. */
const MODEL_HOST = "generativelanguage.googleapis.com";

export class EvalNetworkViolation extends Error {
  readonly host: string;
  readonly tool: string;

  constructor(host: string, tool: string) {
    super(`EvalNetworkViolation: ${host} (tool: ${tool})`);
    this.name = "EvalNetworkViolation";
    this.host = host;
    this.tool = tool;
  }
}

type Fetcher = typeof globalThis.fetch;

export interface NetworkGuardOptions {
  /**
   * What a blocked request is attributed to. The guard runs in the eval process
   * and cannot see which tool the model chose behind the harness, so the label
   * names the eval case that was running. That is still the stub to go look at.
   */
  readonly label?: string;
  /**
   * The eval target's own loopback origin — the agent the harness is driving.
   *
   * Not provider access: starting sessions and reading turns are the harness's
   * control plane. Without this every eval throws before its first turn, which
   * would hide real failures rather than prevent them. Anything that is not
   * loopback is ignored, and the match is the exact origin (scheme, host, port),
   * so a second local service on another port still fails closed.
   */
  readonly controlPlaneOrigin?: string;
}

interface ActiveGuard {
  readonly restore: () => void;
}

// One guard per process. Re-installing returns the live uninstaller instead of
// stacking wrappers, so an eval that forgets to restore cannot double-guard.
let active: ActiveGuard | undefined;

/**
 * Install the guard and return its uninstaller. Call it inside the eval's
 * `test()` and restore in `finally`; at import time it would outlive the eval.
 */
export function installNetworkGuard(options: NetworkGuardOptions = {}): () => void {
  if (active !== undefined) return active.restore;

  const base = globalThis.fetch;
  const controlPlane = loopbackOrigin(options.controlPlaneOrigin);
  const fallbackLabel = options.label ?? "unknown";

  const guarded: Fetcher = async (input, init) => {
    const raw = requestUrl(input);
    const url = parse(raw);
    const permitted =
      url !== undefined &&
      (url.protocol === "https:" && url.hostname === MODEL_HOST || url.origin === controlPlane);
    if (!permitted) throw new EvalNetworkViolation(url?.host ?? raw, fallbackLabel);
    return await base(input, init);
  };

  const restore = () => {
    globalThis.fetch = base;
    active = undefined;
  };
  active = { restore };
  globalThis.fetch = guarded;
  return restore;
}

/** The control plane origin, only when it is loopback; otherwise undefined. */
function loopbackOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  try {
    const url = new URL(origin);
    return isLoopback(url.hostname) ? url.origin : undefined;
  } catch {
    // An unparseable origin grants nothing.
    return undefined;
  }
}

function isLoopback(hostname: string): boolean {
  // URL normalizes `[::1]` to `[::1]`; the brackets are part of `hostname`.
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname === "localhost";
}

function requestUrl(input: Parameters<Fetcher>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  // A Request's `url` is the absolute URL the fetch would use.
  return (input as Request).url;
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}
