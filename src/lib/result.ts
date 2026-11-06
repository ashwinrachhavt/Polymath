import { UserError } from "@/domains/superagent/core/errors";

/*
 * The server-action contract. A success spreads its payload fields at the top
 * level next to `ok`; a failure carries one user-facing message. Expected
 * domain failures return a Result; anything unexpected rethrows into Next.js's
 * 500 path so an unknown error's message never reaches the client (the
 * bug-channel convention — see guarded).
 */

export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * The same contract with a `message` failure field — the wire shape the
 * conversation actions already commit to (run continuation and run questions).
 */
export type MessageResult<T extends object = object> = ({ ok: true } & T) | { ok: false; message: string };

export const ok = <T extends object>(payload: T): Result<T> => ({ ok: true, ...payload });

export const fail = (error: string): Result<never> => ({ ok: false, error });

type DomainError = new (...args: never[]) => Error;

export interface GuardedOptions {
  /** Error classes whose message is safe to surface as the action's failure. */
  domainErrors?: readonly DomainError[];
  /** Maps an ad-hoc error (usually a plain Error from domain code) to its failure message, or undefined to pass. */
  mapError?: (error: unknown) => string | undefined;
  /** Runs when the body succeeds — usually the file's revalidatePath wrapper. */
  onSuccess?: () => void;
}

/*
 * Wraps a fallible action body in the bug-channel convention: known domain
 * errors become `{ ok: false, error }` with their user-facing message, and
 * anything unexpected rethrows so Next.js renders its 500/digest path instead
 * of leaking an internal message to the client.
 */
export async function guarded<T extends object>(
  run: () => Promise<T>,
  options: GuardedOptions = {},
): Promise<Result<T>> {
  try {
    const value = await run();
    options.onSuccess?.();
    return ok(value);
  } catch (error) {
    if (error instanceof UserError) return fail(error.message);
    if (options.domainErrors?.some((E) => error instanceof E)) return fail((error as Error).message);
    const mapped = options.mapError?.(error);
    if (mapped !== undefined) return fail(mapped);
    throw error;
  }
}

/** Binds per-file guarded options once, so action files keep their `guarded(run)` call sites unchanged. */
export function bindGuarded(options: GuardedOptions): <T extends object>(run: () => Promise<T>) => Promise<Result<T>> {
  return (run) => guarded(run, options);
}
