export function futureDeliveryIso(value: string, now: number): string | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() > now ? date.toISOString() : null;
}

export function captureDeliveryIntent(value: string): string | null {
  return futureDeliveryIso(value, Date.now());
}
