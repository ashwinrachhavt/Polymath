/*
 * The alias a connection gets when the owner was not asked to type one: the
 * provider id, then "provider-2", "provider-3". Aliases are workspace-unique
 * across providers because models choose accounts by alias, so the taken set
 * is the whole workspace's — including revoked rows, whose aliases stay taken
 * (they keep pointing at something real). The unique index on
 * external_accounts is the backstop for two flows racing to the same free
 * name; the insert caller surfaces the conflict.
 */
export function nextAlias(taken: readonly string[], provider: string): string {
  const names = new Set(taken);
  if (!names.has(provider)) return provider;
  for (let n = 2; ; n += 1) {
    const candidate = `${provider}-${n}`;
    if (!names.has(candidate)) return candidate;
  }
}
