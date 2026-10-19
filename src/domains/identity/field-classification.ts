/*
 * ASH-121 AC07: field classification and the serialization boundary. Every
 * field that could hold something a person would not want in every browser
 * payload gets a classification here; serializers pass records through
 * `applyFieldPolicy` before they leave the server. Denied values are removed
 * outright - never hashed, truncated or hinted - because a reversible or
 * sized placeholder still leaks.
 *
 * Nothing in the request path calls this yet: the default member policy
 * below allows every registered classification, matching what the product
 * shows members today. The registry and the serializer exist so the guest /
 * restricted-sharing slices (AC04) have one enforced place to subtract from,
 * and so a new sensitive column cannot ship without a conscious entry here.
 */

export const FIELD_CLASSIFICATIONS = ["standard", "personal", "confidential", "restricted"] as const;
export type FieldClassification = (typeof FIELD_CLASSIFICATIONS)[number];

/**
 * The registry: table -> column -> classification. Unregistered columns are
 * "standard" by default; registering a column that does not exist is a test
 * failure, not a silent no-op (the registry test imports the schema).
 */
export const FIELD_REGISTRY: Record<string, Record<string, FieldClassification>> = {
  contacts: {
    primary_email: "personal",
    phone: "personal",
    notes: "confidential",
  },
  companies: {
    // Free-form identifiers (tax ids, registration numbers) land here.
    attributes: "restricted",
    description: "standard",
  },
  correspondence: {
    body: "confidential",
    subject: "personal",
  },
};

export type FieldPolicy = {
  /** Classifications the caller may see. Anything else is removed. */
  allowed: ReadonlySet<FieldClassification>;
};

/** Today's behavior as a policy: members see everything registered. */
export const MEMBER_FIELD_POLICY: FieldPolicy = {
  allowed: new Set(FIELD_CLASSIFICATIONS),
};

/** The nothing-leaks baseline: only unclassified fields pass. */
export const STANDARD_ONLY_POLICY: FieldPolicy = {
  allowed: new Set(["standard"]),
};

export function classificationOf(table: string, column: string): FieldClassification {
  return FIELD_REGISTRY[table]?.[column] ?? "standard";
}

/**
 * Remove denied values from a plain record before serialization. Returns the
 * redacted record plus the names of the removed fields - the fact that a
 * field exists is schema knowledge, its value is what is protected.
 */
export function applyFieldPolicy<T extends Record<string, unknown>>(
  table: string,
  record: T,
  policy: FieldPolicy,
): { record: Partial<T>; redacted: string[] } {
  const out: Record<string, unknown> = {};
  const redacted: string[] = [];
  for (const [column, value] of Object.entries(record)) {
    if (policy.allowed.has(classificationOf(table, column))) {
      out[column] = value;
    } else {
      redacted.push(column);
    }
  }
  return { record: out as Partial<T>, redacted };
}

/** Every registered sensitive field, for the access inspector and audits. */
export function listClassifiedFields(): { table: string; column: string; classification: FieldClassification }[] {
  return Object.entries(FIELD_REGISTRY).flatMap(([table, columns]) =>
    Object.entries(columns).map(([column, classification]) => ({ table, column, classification })),
  );
}
