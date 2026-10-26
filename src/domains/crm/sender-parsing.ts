/*
 * Pure sender analysis for ASH-287: turn a raw `From` header into the person
 * and organisation a CRM proposal would name, and decide which senders are not
 * people at all. No I/O, so every rule is unit-tested instead of discovered in
 * production. The header is untrusted text from outside the workspace: every
 * string it yields is cleaned and length-capped before it can reach a review
 * card.
 */

export type ParsedSender = { email: string; displayName: string | null };

const MAX_NAME = 120;

/** `Ada Lovelace <ada@acme.com>`, `"Lovelace, Ada" <ada@acme.com>` or a bare address. */
export function parseSender(from: string | null | undefined): ParsedSender | null {
  if (!from) return null;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  const bare = /^\s*([^\s<>",;]+@[^\s<>",;]+)\s*$/.exec(from);
  const address = (angle?.[1] ?? bare?.[1])?.toLowerCase();
  if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s.]+$/.test(address)) return null;
  const rawName = angle ? from.slice(0, angle.index) : "";
  const displayName = cleanName(rawName);
  return { email: address, displayName };
}

function cleanName(raw: string): string | null {
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // "Lovelace, Ada" is the one common reordering; a name with two commas is not a person.
  const flipped = /^([^,]+),\s*([^,]+)$/.exec(stripped);
  const name = (flipped ? `${flipped[2]} ${flipped[1]}` : stripped).slice(0, MAX_NAME).trim();
  // A display name that is itself an address (`a@b.com <a@b.com>`) carries no extra information.
  if (!name || name.includes("@")) return null;
  return name;
}

/*
 * Local parts that mark a system or list sender - only ones that can never be
 * a person. Addresses like hello@ or team@ at a small company ARE the person
 * the owner wants in the CRM; a spurious proposal costs one review card, a
 * missed human costs the relationship. The queue is the filter, not this list.
 */
const AUTOMATED_LOCAL_PART =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletter|digest|security|system|automated|calendar-notification)([+._-].*)?$/i;

export function isAutomatedSender(email: string): boolean {
  const [local] = email.split("@");
  return AUTOMATED_LOCAL_PART.test(local) || /^(bounce|mail|email|notify|e|em)\d*\./i.test(email.split("@")[1] ?? "");
}

/** Webmail domains: the domain says nothing about an employer, so no company is proposed. */
const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  "hey.com",
]);

/** Second-level labels that sit under a country code (`acme.co.uk` is `acme`, not `co`). */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

export type SenderCompany = { domain: string; name: string };

/** The company a sender's domain implies, or null for webmail. The name is a title-cased guess the owner reviews. */
export function companyFromEmail(email: string): SenderCompany | null {
  const host = email.split("@")[1]?.toLowerCase();
  if (!host || PERSONAL_DOMAINS.has(host)) return null;
  const labels = host.split(".");
  const tld = labels.length > 2 && SECOND_LEVEL.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
  const registrable = labels.slice(-tld);
  if (registrable.length < 2) return null;
  const domain = registrable.join(".");
  const name = registrable[0]
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
  return name ? { domain, name } : null;
}

/** Fallback contact name when the header carries none: the local part, de-punctuated. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0].replace(/\+.*$/, "");
  const words = local.split(/[._-]+/).filter(Boolean);
  const titled = words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  return (titled || email).slice(0, MAX_NAME);
}

/** A link to the thread in Gmail's own UI; the id is encoded, never trusted as a path. */
export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}
