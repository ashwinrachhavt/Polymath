export function parseMicroUsd(value: string): number | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const micro = BigInt(whole) * BigInt(1000000) + BigInt(fraction.padEnd(6, "0"));
  return micro <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micro) : null;
}
