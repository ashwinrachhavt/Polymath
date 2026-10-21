import { z } from "zod";

/*
 * Shape of an exported source inventory: what the connectors returned, split by
 * source. The 2026-10-20 export found Linear complete and Notion row-complete
 * while Gmail, page bodies, and nested databases were explicitly partial, so
 * completeness is recorded per source rather than assumed.
 *
 * The rules the shape enforces:
 *   - A record is stored under the source's own vocabulary. A Notion category
 *     named "Done" is a category, not proof the thing was done.
 *   - A mailbox is a mailbox. A shared or role address is never merged into a
 *     named person.
 *   - An item the export marked untitled keeps its identifier as its title.
 *     Dropping it would silently shrink the inventory.
 */

const priority = z.enum(["none", "low", "medium", "high", "urgent"]);

export const inventorySchema = z.object({
  snapshotDate: z.string().date(),
  timezone: z.string().min(1),
  verbatim: z.string().min(1).optional(),
  sources: z.object({
    linear: z.object({
      complete: z.boolean(),
      note: z.string().optional(),
      projects: z
        .array(
          z.object({
            name: z.string().min(1),
            team: z.string().nullable().default(null),
            issues: z.array(
              z.object({
                identifier: z.string().regex(/^ASH-\d+$/),
                title: z.string().min(1),
                /** The source's own status wording, kept verbatim. */
                status: z.string().min(1),
                priority,
              }),
            ),
          }),
        )
        .default([]),
    }),
    notion: z.object({
      complete: z.boolean(),
      note: z.string().optional(),
      rows: z
        .array(
          z.object({
            title: z.string().min(1),
            category: z.string().nullable().default(null),
            priority,
            url: z.string().url().nullable().default(null),
            source_id: z.string().nullable().default(null),
            /**
             * Position in the export. Duplicate titles are separate records in
             * the source, so the title alone is not a key.
             */
            record_index: z.number().int().nonnegative(),
          }),
        )
        .default([]),
      extra_pages: z
        .array(z.object({ title: z.string().min(1), location: z.string().nullable().default(null) }))
        .default([]),
    }),
    gmail: z.object({
      complete: z.boolean(),
      note: z.string().optional(),
      messages: z
        .array(
          z.object({
            date: z.string().date(),
            sender: z.string().min(1),
            sender_email: z.string().email().nullable().default(null),
            subject: z.string().min(1),
            organization: z.string().min(1).nullable().default(null),
          }),
        )
        .default([]),
    }),
  }),
  calendar: z.object({
    complete: z.boolean(),
    timezone: z.string().min(1),
    events: z
      .array(
        z.object({
          title: z.string().min(1),
          organization: z.string().min(1).nullable().default(null),
          /** Local wall-clock in the event's own zone, no offset. */
          starts_at: z.string().min(16),
          ends_at: z.string().min(16),
          timezone: z.string().min(1),
          status: z.enum(["confirmed", "tentative", "cancelled"]),
          provider_object_id: z.string().nullable().default(null),
        }),
      )
      .default([]),
  }),
  people: z
    .array(
      z.object({
        name: z.string().min(1),
        email: z.string().email().nullable().default(null),
        organization: z.string().min(1).nullable().default(null),
        title: z.string().nullable().default(null),
        /** Named in the evidence but never a direct correspondent. */
        mentioned_only: z.boolean().default(false),
        /** A shared or role mailbox: never a named person's address. */
        shared_mailbox: z.boolean().default(false),
      }),
    )
    .default([]),
  organizations: z
    .array(
      z.object({
        name: z.string().min(1),
        /** Asserted by the evidence, not guessed from an email domain. */
        domain: z.string().nullable().default(null),
        categories: z.array(z.string()).default([]),
        summary: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

export type Inventory = z.infer<typeof inventorySchema>;
