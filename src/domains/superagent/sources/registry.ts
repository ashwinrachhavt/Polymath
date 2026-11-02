/** The Source registry: registered kinds, and the scope port the Engine receives its receiving rules through. */
import type { ScopeResult, SourceScope } from "../core";
import type { SourceKind } from "./kind";

/**
 * Holds the registered Source kinds and adapts them to the Engine's `SourceScope` port. Configuration comes from the
 * host callback, so a kind's rule is read against the configuration that was stored when the trigger arrived; a
 * disabled or unknown Source listens to nothing, which is what makes a later revalidation of its recorded Mandates
 * refuse them. The rule itself decides from the trigger's `meta` alone, so the same read works for intake and for
 * revalidation.
 */
export class SourceRegistry {
  private readonly kinds = new Map<string, SourceKind>();

  constructor(private readonly configOf: (kind: string) => Record<string, unknown> | undefined) {}

  register(kind: SourceKind): void {
    this.kinds.set(kind.kind, kind);
  }

  unregister(kind: string): void {
    this.kinds.delete(kind);
  }

  get(kind: string): SourceKind | undefined {
    return this.kinds.get(kind);
  }

  /** The `SourceScope` port for `EngineOptions.scope`: dispatches a trigger to its Source's receiving rule. */
  scope(): SourceScope {
    return {
      scope: ({ source, meta }): ScopeResult => {
        const kind = this.kinds.get(source);
        if (!kind) return { listened: false, reason: "unknownSource" };
        const stored = this.configOf(source);
        if (stored === undefined) return { listened: false, reason: "sourceOff" };
        const parsed = kind.schema.safeParse(stored);
        // A configuration that no longer validates receives nothing until it is fixed; the trigger is recorded, not lost.
        if (!parsed.success) return { listened: false, reason: "sourceConfigInvalid" };
        return kind.scope ? kind.scope({ source, meta }, parsed.data) : { listened: true, observed: false };
      },
    };
  }
}
