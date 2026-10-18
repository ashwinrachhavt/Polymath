/** How a proposed field value reads to the owner: money as money, never as JSON. */
export function fieldValueText(value: unknown, note: string | null | undefined): string {
  if (value == null) return note ?? "unreadable";
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toLocaleString("en");
  if (typeof value === "object" && value && "amount" in value && typeof value.amount === "number") {
    const currency = "currency" in value && typeof value.currency === "string" ? value.currency : undefined;
    if (!currency) return value.amount.toLocaleString("en", { minimumFractionDigits: 2 });
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency }).format(value.amount);
    } catch {
      // An unknown currency code is shown as written rather than rejected here.
      return `${currency} ${value.amount.toLocaleString("en", { minimumFractionDigits: 2 })}`;
    }
  }
  return JSON.stringify(value);
}

export function fieldLabel(fieldName: string): string {
  return fieldName.replace(/[_-]+/g, " ");
}
