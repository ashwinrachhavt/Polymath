# TypeScript contracts

## Types and boundaries

- Preserve strict compiler checking. Parse external JSON, tool arguments, environment inputs, and persisted untrusted payloads from `unknown` using the owning runtime schema. A type assertion does not validate data.
- Derive types from the owning schema where they represent the same contract. Use explicit domain types for concepts whose meaning differs from the transport or database row. Avoid parallel hand-maintained copies of identical shapes.
- Use discriminated unions for states with different required fields. Handle all variants; adding a variant should reveal missing cases at compile time.
- Keep `any` out of new application contracts. Use `unknown` plus narrowing for unknown values and generics for preserved relationships. A necessary untyped third-party boundary must be isolated, explain the limitation, and validate its output before it enters domain code. Do not use `as any`, double casts, or non-null assertions to bypass a missing invariant.
- Keep transformations pure when possible. Pass time, randomness, storage, and provider operations through explicit dependencies when behavior depends on them. Await promises or hand them to a durable execution mechanism with explicit error handling.

## Absence and failure

- Use `undefined` for omitted optional input and `null` for an explicitly absent nullable value. Preserve a public contract's existing semantics until callers are migrated.
- For partial updates, omission means unchanged; `null` means clear only when the field is nullable; a value means replace. Validate these cases separately. JSON does not transmit `undefined`.
- A lookup may return `null` for not found. Operational failure must remain distinguishable from not found: propagate or map the error rather than returning an empty collection or null on every exception.
- Narrow nullable values before use. Default with `??` when zero, false, and empty string are valid values. Avoid invented placeholder IDs or empty strings that disguise missing data.
- Treat caught values as unknown. Return a stable public error while preserving a sanitized cause and correlation identifier in internal diagnostics.

## Verification

Run the configured typecheck and lint for code changes. For changed parsing or updates, cover omitted, explicit null, invalid, and valid inputs where their behavior differs. Compiler success does not prove runtime validation or authorization.

Discover current schemas under `src/domains/`; inspect `tsconfig.json` and `eslint.config.mjs` for enforced policy instead of duplicating their settings here.
