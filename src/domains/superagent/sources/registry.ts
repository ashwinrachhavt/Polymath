/** The Source registry: registered kinds, and the scope port the Engine receives its receiving rules through. */
import type { ScopeResult, SourceScope } from "../core";
import type { SourceKind } from "./kind";

/**
 * Holds the registered Source kinds and adapts them to the Engine's `SourceScope` port. Configuration comes from the
 * host callback, so a kind's rule is read against the configuration that was stored when the trigger arrived; a
 * disabled or unknown Source listens to nothing, which is what makes a later revalidation of its recorded Mandates
 * refuse them. The rule itself decides from the trigger's `meta` alone, so the same read works for intake and for
 * revalidation.
 *
 * Stored configuration is trusted data: it was validated when the source was saved, and the host is rebuilt whenever
 * the policy that produced it could have changed. Re-validating it on every dispatch spent the schema's parse
 * machinery on a value that cannot have changed, so a kind's first successful parse is memoized and reused; failed
 * parses are deliberately not memoized, so fixing an invalid configuration is honored on the next dispatch.
 */
export class SourceRegistry {
  private readonly kinds = new Map<string, SourceKind>();
  /** First successful parse per kind; see scope — stored configuration is trusted data. */
  private readonly parsedConfig = new Map<string, Record<string, unknown>>();

  constructor(private readonly configOf: (kind: string) => Record<string, unknown> | undefined) {}

  register(kind: SourceKind): void {
    this.kinds.set(kind.kind, kind);
    this.parsedConfig.delete(kind.kind);
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
        // Stored configuration is trusted data: it was validated when the source was saved and the host is rebuilt
        // when the policy could have changed, so a successful parse is memoized per kind instead of rebuilt on every
        // trigger. Failures are not memoized: a configuration that no longer validates receives nothing until it is
        // fixed (the trigger is recorded, not lost), and the fix is honored on the next dispatch.
        let data = this.parsedConfig.get(source);
        if (data === undefined) {
          const parsed = kind.schema.safeParse(stored);
          if (!parsed.success) return { listened: false, reason: "sourceConfigInvalid" };
          this.parsedConfig.set(source, parsed.data);
          data = parsed.data;
        }
        return kind.scope ? kind.scope({ source, meta }, data) : { listened: true, observed: false };
      },
    };
  }
}
