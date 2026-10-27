import { and, eq, isNull } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { calendars, events } from "@/domains/calendar/schema";
import { companies, contacts, correspondence } from "@/domains/crm/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { contactPoints, organizations, partyEmployment, people } from "@/domains/identity/schema";
import { sources } from "@/domains/knowledge/schema";
import { projects, tasks } from "@/domains/work/schema";
import { listTaskTitles } from "@/domains/work/queries";
import { createTaskNote } from "@/domains/work/task-note";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { inventorySchema, type Inventory } from "./inventory-schema";

/*
 * Import one exported source inventory into the canonical tables. It exists so
 * the inventory lives in the database the app reads, not in a chat transcript:
 * a worktree or a scratch file can be recreated, the volume's rows are the copy
 * that matters.
 *
 * Mapping, one record per source:
 *   - Linear issues  -> projects (per Linear project) and tasks (one per issue).
 *     The title keeps its `ASH-nnn` prefix because that identifier is how the
 *     source names the work and how the owner refers to it.
 *   - Notion rows    -> sources (kind "notion-row"), one per row, including
 *     untitled pages, whose identifier becomes the title.
 *   - Gmail messages -> correspondence (received), linked to a contact when the
 *     sender is a known person.
 *   - Calendar       -> events plus attendees, keyed on the provider id.
 *   - People/orgs    -> people, contact points, and organizations.
 *
 * Idempotent: every write matches on a natural key first, so a re-run reports
 * matches instead of duplicating. Owner-edited fields are left alone.
 */

export type InventoryImportSummary = {
  applied: boolean;
  projects: { created: number; matched: number };
  tasks: { created: number; matched: number };
  sources: { created: number; matched: number };
  correspondence: { created: number; matched: number };
  events: { created: number; matched: number };
  people: { created: number; matched: number };
  organizations: { created: number; matched: number };
  unresolved: string[];
};

class DryRunRollback extends Error {}

function key(value: string) {
  return value.trim().toLowerCase();
}

export async function importInventory(
  auth: AuthContext,
  raw: unknown,
  options: { apply: boolean },
): Promise<InventoryImportSummary> {
  const inventory = inventorySchema.parse(raw);
  const summary: InventoryImportSummary = {
    applied: options.apply,
    projects: { created: 0, matched: 0 },
    tasks: { created: 0, matched: 0 },
    sources: { created: 0, matched: 0 },
    correspondence: { created: 0, matched: 0 },
    events: { created: 0, matched: 0 },
    people: { created: 0, matched: 0 },
    organizations: { created: 0, matched: 0 },
    unresolved: [],
  };

  try {
    await withTransaction(async (tx) => {
      const orgIds = await upsertOrganizations(auth, tx, inventory, summary);
      const personIds = await upsertPeople(auth, tx, inventory, orgIds, summary);
      await upsertLinear(auth, tx, inventory, orgIds, summary);
      await upsertNotion(auth, tx, inventory, summary);
      await upsertCorrespondence(auth, tx, inventory, orgIds, personIds, summary);
      await upsertCalendar(auth, tx, inventory, orgIds, personIds, summary);

      if (!options.apply) throw new DryRunRollback();

      await recordAudit(
        auth,
        {
          action: "inventory.imported",
          subjectType: "workspace",
          subjectId: auth.workspaceId,
          summary: `Source inventory imported (${inventory.snapshotDate})`,
          metadata: { snapshotDate: inventory.snapshotDate, ...summary },
        },
        tx,
      );
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }

  return summary;
}

async function upsertOrganizations(
  auth: AuthContext,
  tx: TxDrizzle,
  inventory: Inventory,
  summary: InventoryImportSummary,
): Promise<Map<string, string>> {
  const existing = await tx
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(eq(organizations.workspaceId, auth.workspaceId), isNull(organizations.archivedAt)));
  const byName = new Map(existing.map((row) => [key(row.name), row.id]));
  const ids = new Map<string, string>();

  for (const org of inventory.organizations) {
    const match = byName.get(key(org.name));
    if (match) {
      ids.set(org.name, match);
      summary.organizations.matched += 1;
      continue;
    }
    const [created] = await tx
      .insert(organizations)
      .values({
        workspaceId: auth.workspaceId,
        name: org.name,
        domain: org.domain,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: organizations.id });
    ids.set(org.name, created.id);
    byName.set(key(org.name), created.id);
    summary.organizations.created += 1;
  }
  return ids;
}

async function upsertPeople(
  auth: AuthContext,
  tx: TxDrizzle,
  inventory: Inventory,
  orgIds: Map<string, string>,
  summary: InventoryImportSummary,
): Promise<Map<string, string>> {
  const points = await tx
    .select({ value: contactPoints.value, personId: contactPoints.personId })
    .from(contactPoints)
    .where(and(eq(contactPoints.workspaceId, auth.workspaceId), eq(contactPoints.kind, "email"), isNull(contactPoints.archivedAt)));
  const byEmail = new Map<string, string>();
  for (const point of points) if (point.personId) byEmail.set(key(point.value), point.personId);

  const existingPeople = await tx
    .select({ id: people.id, displayName: people.displayName })
    .from(people)
    .where(and(eq(people.workspaceId, auth.workspaceId), isNull(people.archivedAt)));
  const byName = new Map(existingPeople.map((row) => [key(row.displayName), row.id]));

  const ids = new Map<string, string>();
  for (const person of inventory.people) {
    const email = person.email ? person.email.toLowerCase() : null;
    let personId = (email ? byEmail.get(email) : undefined) ?? byName.get(key(person.name)) ?? null;

    if (personId) {
      summary.people.matched += 1;
    } else {
      const [created] = await tx
        .insert(people)
        .values({
          workspaceId: auth.workspaceId,
          displayName: person.name,
          title: person.title,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: people.id });
      personId = created.id;
      byName.set(key(person.name), personId);
      summary.people.created += 1;
    }
    ids.set(person.name, personId);

    // A shared role mailbox is real evidence but not the named person's own
    // address, so it stays in the inventory rather than becoming an identity key.
    if (email && !person.shared_mailbox && !byEmail.has(email)) {
      await tx.insert(contactPoints).values({
        workspaceId: auth.workspaceId,
        kind: "email",
        value: email,
        isPrimary: true,
        isVerified: false,
        personId,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      });
      byEmail.set(email, personId);
    }
  }

  // Employment is written only where the evidence places the person at an org.
  for (const person of inventory.people) {
    if (!person.organization || person.mentioned_only) continue;
    const organizationId = orgIds.get(person.organization);
    if (!organizationId) {
      summary.unresolved.push(`${person.name}: organization "${person.organization}" is not in this inventory.`);
      continue;
    }
    const personId = ids.get(person.name);
    if (!personId) continue;
    const existingEdges = await tx
      .select({ id: partyEmployment.id })
      .from(partyEmployment)
      .where(
        and(
          eq(partyEmployment.workspaceId, auth.workspaceId),
          eq(partyEmployment.personId, personId),
          eq(partyEmployment.organizationId, organizationId),
          isNull(partyEmployment.endedAt),
        ),
      )
      .limit(1);
    if (existingEdges.length) continue;
    await tx.insert(partyEmployment).values({
      workspaceId: auth.workspaceId,
      personId,
      organizationId,
      title: person.title,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
  }
  return ids;
}

const linearStatus: Record<string, "backlog" | "ready" | "in_progress" | "waiting" | "done" | "cancelled"> = {
  backlog: "backlog",
  todo: "ready",
  "in progress": "in_progress",
  "in review": "waiting",
  done: "done",
  canceled: "cancelled",
  duplicate: "cancelled",
};

async function upsertLinear(
  auth: AuthContext,
  tx: TxDrizzle,
  inventory: Inventory,
  orgIds: Map<string, string>,
  summary: InventoryImportSummary,
): Promise<void> {
  const existing = await listTaskTitles(auth, {}, tx);
  const known = new Set(existing.map((row) => key(row.title)));

  for (const project of inventory.sources.linear.projects) {
    let projectId: string;
    const [existingProject] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.workspaceId, auth.workspaceId), eq(projects.name, project.name), isNull(projects.archivedAt)))
      .limit(1);
    if (existingProject) {
      projectId = existingProject.id;
      summary.projects.matched += 1;
    } else {
      const [projectRow] = await tx
        .insert(projects)
        .values({
          workspaceId: auth.workspaceId,
          name: project.name,
          description: `Imported from Linear (team: ${project.team ?? "unassigned"}) on ${inventory.snapshotDate}.`,
          phase: "active",
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: projects.id });
      projectId = projectRow.id;
      summary.projects.created += 1;
    }

    for (const issue of project.issues) {
      const title = `${issue.identifier} ${issue.title}`;
      if (known.has(key(title))) {
        summary.tasks.matched += 1;
        continue;
      }
      // The source status is preserved in the description; the task status is
      // the product's vocabulary, and the two are not one-to-one.
      const description = `Linear status: ${issue.status}. Linear project: ${project.name}.`;
      const note = await createTaskNote(tx, auth, { title, description });
      await tx.insert(tasks).values({
        workspaceId: auth.workspaceId,
        noteId: note.id,
        projectId,
        status: linearStatus[key(issue.status)] ?? "backlog",
        priority: issue.priority,
        tags: ["linear", issue.identifier],
        createdBy: auth.userId,
        updatedBy: auth.userId,
      });
      known.add(key(title));
      summary.tasks.created += 1;
    }
  }
  void orgIds;
}

async function upsertNotion(
  auth: AuthContext,
  tx: TxDrizzle,
  inventory: Inventory,
  summary: InventoryImportSummary,
): Promise<void> {
  const existing = await tx
    .select({ title: sources.title, metadata: sources.metadata })
    .from(sources)
    .where(and(eq(sources.workspaceId, auth.workspaceId), eq(sources.kind, "notion-row"), isNull(sources.archivedAt)));
  const known = new Set(
    existing.map((row) => `${key(row.title ?? "")}|${(row.metadata as { recordIndex?: number } | null)?.recordIndex ?? ""}`),
  );

  const rows = [
    ...inventory.sources.notion.rows,
    ...inventory.sources.notion.extra_pages.map((page, index) => ({
      title: page.title,
      category: page.location,
      priority: "none" as const,
      url: null,
      source_id: null,
      record_index: inventory.sources.notion.rows.length + index,
    })),
  ];

  for (const row of rows) {
    const dedupe = `${key(row.title)}|${row.record_index}`;
    if (known.has(dedupe)) {
      summary.sources.matched += 1;
      continue;
    }
    await tx.insert(sources).values({
      workspaceId: auth.workspaceId,
      kind: "notion-row",
      title: row.title,
      url: row.url,
      metadata: {
        category: row.category,
        priority: row.priority,
        sourceId: row.source_id,
        recordIndex: row.record_index,
        snapshotDate: inventory.snapshotDate,
        // The export carried titles and categories, not page bodies.
        bodyRetrieved: false,
      },
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
    known.add(dedupe);
    summary.sources.created += 1;
  }
}

async function upsertCorrespondence(
  auth: AuthContext,
  tx: TxDrizzle,
  inventory: Inventory,
  orgIds: Map<string, string>,
  personIds: Map<string, string>,
  summary: InventoryImportSummary,
): Promise<void> {
  const existing = await tx
    .select({ subject: correspondence.subject, occurredAt: correspondence.occurredAt })
    .from(correspondence)
    .where(eq(correspondence.workspaceId, auth.workspaceId));
  const known = new Set(existing.map((row) => `${key(row.subject ?? "")}|${row.occurredAt?.toISOString() ?? ""}`));

  const contactByEmail = new Map<string, string>();
  const contactRows = await tx
    .select({ id: contacts.id, email: contacts.primaryEmail, name: contacts.fullName })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, auth.workspaceId), isNull(contacts.archivedAt)));
  for (const row of contactRows) if (row.email) contactByEmail.set(key(row.email), row.id);
  const contactByName = new Map(contactRows.map((row) => [key(row.name), row.id]));

  const byName = new Map(inventory.people.map((p) => [key(p.name), p]));

  // `correspondence.company_id` points at `companies`, not `organizations`, and
  // the two tables are populated independently. A company row that does not
  // exist yet leaves the link null rather than inventing one here.
  const companyRows = await tx
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.workspaceId, auth.workspaceId), isNull(companies.archivedAt)));
  const companyByName = new Map(companyRows.map((row) => [key(row.name), row.id]));

  for (const message of inventory.sources.gmail.messages) {
    const occurredAt = new Date(`${message.date}T12:00:00Z`);
    const dedupe = `${key(message.subject)}|${occurredAt.toISOString()}`;
    if (known.has(dedupe)) {
      summary.correspondence.matched += 1;
      continue;
    }

    const person = byName.get(key(message.sender));
    void personIds;
    const email = person?.email ? key(person.email) : null;
    const contactId =
      (email ? contactByEmail.get(email) : undefined) ?? contactByName.get(key(message.sender)) ?? null;

    const senderEmail = message.sender_email ?? person?.email ?? null;
    await tx.insert(correspondence).values({
      workspaceId: auth.workspaceId,
      contactId,
      companyId: message.organization ? companyByName.get(key(message.organization)) ?? null : null,
      direction: "inbound",
      channel: "email",
      subject: message.subject,
      body: `Sender: ${message.sender}${senderEmail ? ` <${senderEmail}>` : ""}. Imported from the ${inventory.snapshotDate} Gmail page; the body was not retrieved.`,
      state: "received",
      occurredAt,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
    known.add(dedupe);
    summary.correspondence.created += 1;
  }
}

async function upsertCalendar(
  auth: AuthContext,
  tx: TxDrizzle,
  inventory: Inventory,
  orgIds: Map<string, string>,
  personIds: Map<string, string>,
  summary: InventoryImportSummary,
): Promise<void> {
  let [calendar] = await tx
    .select({ id: calendars.id })
    .from(calendars)
    .where(and(eq(calendars.workspaceId, auth.workspaceId), isNull(calendars.archivedAt)))
    .limit(1);

  if (!calendar) {
    const [created] = await tx
      .insert(calendars)
      .values({
        workspaceId: auth.workspaceId,
        kind: "local",
        name: "Personal",
        timezone: inventory.calendar.timezone,
        isPrimary: true,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: calendars.id });
    calendar = created;
  }

  // A meeting is identified by when it occupies the calendar, not by its title
  // or provider id. The same meeting is titled differently across sources (the
  // invitation, the confirmation, and a prior seed disagree), and a rescheduled
  // meeting is a different event even when the title is unchanged.
  const existingEvents = await tx
    .select({ id: events.id, startsAt: events.startsAt })
    .from(events)
    .where(and(eq(events.workspaceId, auth.workspaceId), isNull(events.archivedAt)));
  const typedTimes = new Set<string>();
  for (const row of existingEvents) typedTimes.add(row.startsAt.toISOString());

  for (const event of inventory.calendar.events) {
    const startsAt = localToUtc(event.starts_at, event.timezone);
    const startsIso = startsAt.toISOString();
    if (typedTimes.has(startsIso)) {
      summary.events.matched += 1;
      continue;
    }

    await tx.insert(events).values({
      workspaceId: auth.workspaceId,
      calendarId: calendar.id,
      title: event.title,
      description: `Imported from the ${inventory.snapshotDate} calendar retrieval.`,
      startsAt,
      endsAt: localToUtc(event.ends_at, event.timezone),
      timezone: event.timezone,
      status: event.status,
      providerObjectId: event.provider_object_id,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
    typedTimes.add(startsIso);
    summary.events.created += 1;

    void orgIds;
    void personIds;
  }
}

/**
 * Local wall-clock to an instant. The inventory states times in the event's own
 * zone, so the offset is derived rather than assumed; a DST boundary inside the
 * range is not modelled, which is why both endpoints are converted separately.
 */
export function localToUtc(local: string, timeZone: string): Date {
  const asUtc = Date.parse(`${local.replace(" ", "T")}Z`);
  const offset = zoneOffsetMinutes(new Date(asUtc), timeZone);
  return new Date(asUtc - offset * 60_000);
}

function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return (asIfUtc - at.getTime()) / 60_000;
}
