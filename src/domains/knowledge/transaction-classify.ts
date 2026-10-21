/*
 * Transaction classifier. Pure and local: takes ledger rows, returns a typed
 * judgment per row. No network, no hosted model, so statement data never
 * leaves the machine.
 *
 * Shape borrowed from koladev32/jev-classify (https://github.com/koladev32/jev-classify):
 * a fixed taxonomy with a written criterion per class, a typed judgment of
 * {class, confidence, probability distribution}, and a confidence gate that
 * sends anything unsure to an exception-review route instead of guessing.
 * Jev itself is a hosted API, so it is deliberately not called here. The
 * `Classifier` seam below is where a hosted provider could be added later, but
 * only behind an explicit owner opt-in, because statement rows are private.
 *
 * Evidence order, strongest first:
 *   1. owner rules - a correction the owner already made, confidence 1
 *   2. keyword evidence - weighted patterns per category, direction-aware
 *   3. nothing - "unknown", routed to review
 * The gate decides, never the score alone: a low margin between the top two
 * classes goes to review even when the top probability looks high.
 */

export const CATEGORY_CRITERIA = {
  income_salary: "Regular pay from an employer.",
  income_other: "Money in that is not salary or a refund: interest, gifts, business receipts.",
  refund: "A reversal or return of an earlier payment.",
  transfer: "Money moved to or from a person or another account, with no purchase.",
  housing: "Rent, mortgage, maintenance, property charges.",
  groceries: "Food and household supplies bought to cook or keep at home.",
  dining: "Restaurants, cafes, food delivery.",
  transport: "Fuel, rides, transit, tolls, parking.",
  utilities: "Electricity, water, gas, internet, mobile.",
  subscriptions: "Recurring digital or membership services.",
  shopping: "Retail and online purchases of goods.",
  health: "Doctors, pharmacy, hospitals, insurance claims paid out.",
  travel: "Flights, hotels, trains, trip bookings.",
  fees_interest: "Bank fees, charges, interest paid, penalties.",
  cash: "Cash withdrawals and deposits.",
  tax: "Income tax, GST, and other government payments.",
  investment: "Brokerage, mutual funds, deposits to investment accounts.",
  loan_emi: "Loan or credit-card repayments and EMIs.",
  insurance: "Insurance premiums.",
  education: "Tuition, courses, books for study.",
  entertainment: "Movies, games, events, streaming of one-off content.",
  unknown: "The category cannot be determined reliably from the description.",
} as const;

export type Category = keyof typeof CATEGORY_CRITERIA;

/** Where a judgment goes next, like Jev's route table. */
export type Route = "auto" | "review";

export type Judgment = {
  category: Category;
  confidence: number;
  /** Probability per category, summing to 1, only classes above 0.001. */
  distribution: Partial<Record<Category, number>>;
  source: "owner_rule" | "keywords" | "none";
  route: Route;
  /** Short human-readable reasons, safe to show next to the row. */
  evidence: string[];
  /** The normalized merchant key an owner correction should be stored under. */
  merchantKey: string;
};

export type OwnerRule = { merchantKey: string; category: Category };

export type ClassifiableRow = { description: string; amount: string };

export type ClassifyOptions = {
  ownerRules?: OwnerRule[];
  /** Minimum top probability to skip review. Default 0.7. */
  minConfidence?: number;
  /** Minimum gap between the top two classes to skip review. Default 0.25. */
  minMargin?: number;
};

type Direction = "out" | "in" | "any";
type Signal = { pattern: RegExp; weight: number; direction: Direction; label: string };

const s = (pattern: RegExp, weight: number, label: string, direction: Direction = "any"): Signal => ({
  pattern,
  weight,
  direction,
  label,
});

const SIGNALS: Partial<Record<Category, Signal[]>> = {
  income_salary: [
    s(/\b(salary|payroll|wages?)\b/, 4, "salary keyword", "in"),
    s(/\b(loan labs|direct dep(osit)?)\b/, 1.5, "employer deposit", "in"),
  ],
  income_other: [
    s(/\b(interest (credit|paid|earned)|int\.? ?pd|credit interest|dividend)\b/, 3.5, "interest or dividend", "in"),
    s(/\b(cashback|reward)\b/, 2, "cashback", "in"),
    s(/\b(invoice|client|consulting|freelance)\b/, 1.5, "business receipt", "in"),
  ],
  refund: [s(/\b(refund|reversal|reversed|chargeback|returned|rev)\b/, 4, "refund keyword", "in")],
  transfer: [
    s(/\b(neft|imps|rtgs|ach|wire|zelle|venmo|paypal|transfer|trf|p2p)\b/, 2.2, "transfer rail"),
    s(/\bupi\b/, 1.2, "UPI payment"),
    s(/\b(self|own account|to savings|from savings|to checking|from checking)\b/, 1.5, "own-account wording"),
  ],
  housing: [
    s(/\b(rent|landlord|lease|mortgage|hoa|maintenance charges?|property)\b/, 4, "housing keyword", "out"),
  ],
  groceries: [
    s(/\b(grocer(y|ies)|supermarket|bigbasket|blinkit|zepto|instamart|kroger|safeway|trader joe|whole foods|costco|walmart|aldi|dmart|reliance fresh|more retail)\b/, 4, "grocery merchant", "out"),
  ],
  dining: [
    s(/\b(restaurant|cafe|coffee|starbucks|mcdonald|dominos|pizza|burger|zomato|swiggy|doordash|uber eats|grubhub|chipotle|bakery|dhaba|biryani|kitchen)\b/, 4, "dining merchant", "out"),
  ],
  transport: [
    s(/\b(uber|ola|lyft|rapido|metro|irctc|fuel|petrol|diesel|shell|chevron|bp|indian oil|hpcl|bpcl|fastag|toll|parking|transit|clipper)\b/, 3.6, "transport merchant", "out"),
  ],
  utilities: [
    s(/\b(electric(ity)?|bescom|tneb|water bill|gas bill|broadband|airtel|jio|vodafone|vi prepaid|comcast|xfinity|verizon|at&t|t-mobile|internet|utility|recharge)\b/, 3.8, "utility provider", "out"),
  ],
  subscriptions: [
    s(/\b(netflix|spotify|prime video|amazon prime|hotstar|youtube premium|icloud|apple\.com\/bill|google (one|storage)|chatgpt|openai|anthropic|github|notion|linear|vercel|figma|dropbox|adobe|subscription|membership)\b/, 4, "subscription service", "out"),
  ],
  shopping: [
    s(/\b(amazon|flipkart|myntra|ajio|target|best buy|ebay|etsy|nykaa|shopify|apple store|ikea|retail|mart|store)\b/, 2.6, "retail merchant", "out"),
  ],
  health: [
    s(/\b(pharmacy|apollo|medplus|hospital|clinic|doctor|dr\.|dental|diagnostic|cvs|walgreens|lab|medical)\b/, 3.8, "health provider", "out"),
  ],
  travel: [
    s(/\b(airlines?|air india|indigo|vistara|delta|united air|southwest|makemytrip|goibibo|booking\.com|airbnb|expedia|hotel|resort|marriott|hilton|oyo|cleartrip|redbus)\b/, 4, "travel merchant", "out"),
  ],
  fees_interest: [
    s(/\b(fee|fees|charges?|chgs?|penalty|late fee|service charge|sms charges|annual fee|gst on|interest (debit|charged)|overdraft|maintenance fee|atm fee|foreign transaction)\b/, 4, "fee keyword", "out"),
  ],
  cash: [s(/\b(atm|cash (wdl|withdrawal|deposit)|nfs|cdm|cash)\b/, 3.8, "cash keyword")],
  tax: [
    s(/\b(income tax|advance tax|tds|gst|irs|tax payment|cbdt|challan|state tax|franchise tax|taxes)\b/, 4, "tax keyword", "out"),
  ],
  investment: [
    s(/\b(zerodha|groww|upstox|robinhood|fidelity|vanguard|schwab|etrade|mutual fund|sip|nps|ppf|demat|brokerage|coinbase|kuvera)\b/, 4, "investment platform", "out"),
  ],
  loan_emi: [
    s(/\b(emi|loan|repayment|instalment|installment|credit card (payment|bill)|card payment|autopay)\b/, 4, "loan or card repayment", "out"),
  ],
  insurance: [s(/\b(insurance|premium|lic|geico|allstate|progressive|policy|star health|hdfc ergo|icici lombard)\b/, 4, "insurance keyword", "out")],
  education: [s(/\b(tuition|university|college|school|course|coursera|udemy|edx|exam fee|books?)\b/, 3.6, "education keyword", "out")],
  entertainment: [s(/\b(cinema|movie|pvr|inox|bookmyshow|steam|playstation|xbox|concert|ticketmaster|amc theatres)\b/, 4, "entertainment merchant", "out")],
};

const RAIL_PREFIX =
  /^(upi|neft|imps|rtgs|ach|pos|ecom|ach d|ach c|nach|ecs|bil|inf|mmt|ib|mob|visa|debit card|credit card|purchase|payment|withdrawal|deposit|online|card|txn|trf|transfer)\b[\s/:*-]*/;

/**
 * A stable key for "who is this": rails, long reference numbers and dates are
 * stripped so the same merchant produces the same key on every statement.
 * Owner corrections are stored under this key.
 */
export function merchantKey(description: string): string {
  let text = description.toLowerCase().replace(/[^\p{L}\p{N}@&./ -]+/gu, " ");
  text = text.replace(/\b\d{6,}\b/g, " ").replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, " ");
  text = text.replace(/\b(xx+|x{2,}\d*)\b/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2; i += 1) text = text.replace(RAIL_PREFIX, "");
  const tokens = text
    .split(/[\s/]+/)
    .filter((token) => token.length > 1 && !/^\d+$/.test(token) && !/^[a-z]*\d{4,}[a-z\d]*$/.test(token));
  return tokens.slice(0, 3).join(" ");
}

function normalize(description: string): string {
  return description.toLowerCase().replace(/\s+/g, " ").trim();
}

const UNKNOWN_PRIOR = 1.2;

function softmax(scores: Array<[Category, number]>): Array<[Category, number]> {
  const max = Math.max(...scores.map(([, v]) => v));
  const exps = scores.map(([c, v]) => [c, Math.exp(v - max)] as [Category, number]);
  const sum = exps.reduce((acc, [, v]) => acc + v, 0);
  return exps.map(([c, v]) => [c, v / sum]);
}

export function classifyTransaction(row: ClassifiableRow, options: ClassifyOptions = {}): Judgment {
  const minConfidence = options.minConfidence ?? 0.7;
  const minMargin = options.minMargin ?? 0.25;
  const key = merchantKey(row.description);
  const amount = Number.parseFloat(row.amount);
  const direction: Direction = Number.isFinite(amount) ? (amount < 0 ? "out" : "in") : "any";

  const rule = key ? options.ownerRules?.find((entry) => entry.merchantKey === key) : undefined;
  if (rule) {
    return {
      category: rule.category,
      confidence: 1,
      distribution: { [rule.category]: 1 },
      source: "owner_rule",
      route: "auto",
      evidence: ["your earlier correction for this merchant"],
      merchantKey: key,
    };
  }

  const text = normalize(row.description);
  const scores = new Map<Category, number>();
  const evidence = new Map<Category, string[]>();
  for (const [category, signals] of Object.entries(SIGNALS) as Array<[Category, Signal[]]>) {
    for (const signal of signals) {
      if (signal.direction !== "any" && direction !== "any" && signal.direction !== direction) continue;
      if (!signal.pattern.test(text)) continue;
      scores.set(category, (scores.get(category) ?? 0) + signal.weight);
      evidence.set(category, [...(evidence.get(category) ?? []), signal.label]);
    }
  }

  // Money out that the keywords call a transfer rail only is weak evidence;
  // a specific merchant signal always outweighs it.
  const entries: Array<[Category, number]> = [...scores.entries()];
  entries.push(["unknown", UNKNOWN_PRIOR]);
  const probs = softmax(entries).sort((a, b) => b[1] - a[1]);

  const [top, topProb] = probs[0];
  const secondProb = probs[1]?.[1] ?? 0;
  const matched = scores.size > 0;
  const gated = matched && top !== "unknown" && topProb >= minConfidence && topProb - secondProb >= minMargin;

  const distribution: Judgment["distribution"] = {};
  for (const [category, probability] of probs) {
    if (probability >= 0.001) distribution[category] = Math.round(probability * 1000) / 1000;
  }

  return {
    category: matched ? top : "unknown",
    confidence: matched ? Math.round(topProb * 1000) / 1000 : 0,
    distribution,
    source: matched ? "keywords" : "none",
    route: gated ? "auto" : "review",
    evidence: matched ? (evidence.get(top) ?? []) : [],
    merchantKey: key,
  };
}

export function classifyTransactions(rows: ClassifiableRow[], options: ClassifyOptions = {}): Judgment[] {
  return rows.map((row) => classifyTransaction(row, options));
}

/** Seam for a future provider. Local rules are the only implementation today. */
export type Classifier = (rows: ClassifiableRow[]) => Promise<Judgment[]> | Judgment[];

export type ClassificationSummary = {
  total: number;
  auto: number;
  review: number;
  byCategory: Partial<Record<Category, { count: number; spent: string; received: string }>>;
};

export function summarize(rows: ClassifiableRow[], judgments: Judgment[]): ClassificationSummary {
  const byCategory: ClassificationSummary["byCategory"] = {};
  const totals = new Map<Category, { count: number; spent: number; received: number }>();
  let auto = 0;
  rows.forEach((row, index) => {
    const judgment = judgments[index];
    if (judgment.route === "auto") auto += 1;
    const amount = Number.parseFloat(row.amount) || 0;
    const current = totals.get(judgment.category) ?? { count: 0, spent: 0, received: 0 };
    current.count += 1;
    if (amount < 0) current.spent += -amount;
    else current.received += amount;
    totals.set(judgment.category, current);
  });
  for (const [category, value] of totals) {
    byCategory[category] = {
      count: value.count,
      spent: value.spent.toFixed(2),
      received: value.received.toFixed(2),
    };
  }
  return { total: rows.length, auto, review: rows.length - auto, byCategory };
}
