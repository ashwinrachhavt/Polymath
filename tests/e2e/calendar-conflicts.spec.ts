import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * ASH-282: the owner's side of a calendar conflict. A local event overlaps a
 * synced Google event; the agent's move proposal appears in Calendar Assist's
 * pending list with the truthful from/to, zone and clash, and rejecting it
 * changes nothing. Google events stay advice only and every refusal leaves the
 * queue untouched. Approval is not exercised: it would move a row, and this
 * journey asserts the card, not the write (that path is in
 * tests/integration/calendar-conflicts.test.ts).
 *
 * The proposal comes from the real service (listCalendarConflicts ->
 * proposeConflictMove), not a hand-written row, so the card text under test is
 * what an agent run produces. The week's events are seeded with SQL because
 * nothing in the product syncs Google here; nothing is sent to Google.
 *
 * Isolation: every title, account alias and run id carries a per-attempt tag,
 * assertions are scoped to cards carrying it, and cleanup deletes only the ids
 * this attempt created. No shared fixture, no workspace-wide counts.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;
const DAY = 86_400_000;

function connection(): string | null {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // No .env: the journey skips.
    }
  }
  return process.env.DATABASE_URL ?? null;
}

/** The note's time format, built independently of the service from the same instant and zone. */
function fmt(at: Date, timeZone: string) {
  return at.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
}

for (const vp of VIEWPORTS) {
  test(`a move proposal for a clash with a Google event is truthful and reversible [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    const url = connection();
    test.skip(!url, "DATABASE_URL not configured");
    await page.setViewportSize({ width: vp.width, height: vp.height });

    // The dev owner exists once any page has loaded.
    await page.goto("/neuralflow/work?view=calendar");
    const sql = postgres(url!, { max: 1 });
    const tag = `${vp.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const created = { events: [] as string[], calendars: [] as string[], accounts: [] as string[], proposals: [] as string[] };

    try {
      const [owner] = await sql<{ workspace_id: string; user_id: string }[]>`
        select m.workspace_id, m.user_id from memberships m join users u on u.id = m.user_id
        where u.clerk_user_id = 'dev-user' and m.status = 'active' limit 1`;
      expect(owner).toBeTruthy();
      const [prefs] = await sql<{ timezone: string }[]>`
        select timezone from user_preferences where workspace_id = ${owner.workspace_id} and user_id = ${owner.user_id}`;
      const timeZone = prefs?.timezone ?? "UTC";

      // Three days out, so the proposed slot is in the future and in view.
      // The desktop and mobile variants run in parallel against one database:
      // identical slots would merge both variants' events into one conflict
      // group and each would see move options for the other's event.
      const day = new Date(Date.now() + (vp.name === "mobile" ? 4 : 3) * DAY);
      const at = (h: number, m = 0) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m));
      const dateKey = at(0).toISOString().slice(0, 10);
      const localTitle = `Planning ${tag}`;
      const googleTitle = `Dentist ${tag}`;

      const [local] = await sql<{ id: string; version: number; calendar_id: string }[]>`
        with cal as (
          insert into calendars (workspace_id, kind, name) values (${owner.workspace_id}, 'local', ${`e2e-local-${tag}`})
          returning id)
        insert into events (workspace_id, calendar_id, title, starts_at, ends_at)
        select ${owner.workspace_id}, cal.id, ${localTitle}, ${at(15)}, ${at(16)} from cal
        returning id, version, calendar_id`;
      created.events.push(local.id);
      created.calendars.push(local.calendar_id);

      const alias = `e2e-google-${tag}`;
      const [account] = await sql<{ id: string }[]>`
        insert into external_accounts (workspace_id, provider, alias, status)
        values (${owner.workspace_id}, 'google-calendar', ${alias}, 'active') returning id`;
      created.accounts.push(account.id);
      const [google] = await sql<{ id: string; version: number; calendar_id: string }[]>`
        with cal as (
          insert into calendars (workspace_id, kind, name, external_account_id, provider_object_id)
          values (${owner.workspace_id}, 'external', ${`Google (${alias})`}, ${account.id}, 'primary') returning id)
        insert into events (workspace_id, calendar_id, title, starts_at, ends_at, external_account_id, provider_object_id)
        select ${owner.workspace_id}, cal.id, ${googleTitle}, ${at(15, 30)}, ${at(16, 30)}, ${account.id}, ${`e2e-${tag}`} from cal
        returning id, version, calendar_id`;
      created.events.push(google.id);
      created.calendars.push(google.calendar_id);

      // The real service, as an agent run would call it.
      const auth = { workspaceId: owner.workspace_id, userId: owner.user_id };
      const service = await import("../../src/domains/calendar/conflict-proposals");
      const runId = crypto.randomUUID();
      const report = await service.listCalendarConflicts(auth, { days: 7 });
      const conflict = report.conflicts.find((c) => c.events.some((e) => e.id === local.id));
      expect(conflict, "the seeded overlap is reported").toBeTruthy();
      expect(conflict!.events.find((e) => e.id === google.id)?.source).toBe("google");
      expect(conflict!.events.find((e) => e.id === local.id)?.source).toBe("polymath");
      // Moves are offered only for the Polymath event; Google gets advice.
      const moves = conflict!.options.filter((o) => o.kind === "move");
      expect(moves.length).toBeGreaterThan(0);
      expect(moves.every((o) => o.eventId === local.id)).toBe(true);
      expect(conflict!.options.some((o) => o.kind === "resolve_in_provider" && o.eventId === google.id)).toBe(true);
      const option = moves[0];
      if (option.kind !== "move") throw new Error("expected a move option");
      expect(option.tradeOffs[0]).toContain(`Moves "${localTitle}"`);
      expect(option.tradeOffs[0]).toContain(fmt(new Date(option.startsAt), timeZone));
      expect(report.notices.join(" ")).toContain(alias);

      // Refusals leave the queue alone: Google event, stale version, taken slot.
      const refuse = (input: Parameters<typeof service.proposeConflictMove>[1]) => service.proposeConflictMove(auth, input);
      expect(await refuse({ eventId: google.id, expectedVersion: google.version, startsAt: at(18), endsAt: at(19), runId })).toMatchObject({ ok: false, code: "event_is_external" });
      expect(await refuse({ eventId: local.id, expectedVersion: local.version + 9, startsAt: new Date(option.startsAt), endsAt: new Date(option.endsAt), runId })).toMatchObject({ ok: false, code: "event_changed" });
      expect(await refuse({ eventId: local.id, expectedVersion: local.version, startsAt: at(15, 30), endsAt: at(16, 30), runId })).toMatchObject({ ok: false, code: "slot_unavailable" });

      const proposed = await service.proposeConflictMove(auth, {
        eventId: local.id,
        expectedVersion: option.expectedVersion,
        startsAt: new Date(option.startsAt),
        endsAt: new Date(option.endsAt),
        runId,
      });
      expect(proposed).toMatchObject({ ok: true, deduplicated: false });
      if (!proposed.ok) throw new Error("proposal refused");
      created.proposals.push(proposed.proposalId);

      // The owner's view: one card for this attempt, with the truthful change.
      await page.goto(`/neuralflow/work?view=calendar&date=${dateKey}`);
      const cards = page.getByRole("list", { name: "Agent proposals" }).getByRole("listitem").filter({ hasText: tag });
      await expect(cards).toHaveCount(1);
      const card = cards.first();
      await expect(card).toContainText(`Move event: ${localTitle}`);
      await expect(card).toContainText(`from ${fmt(at(15), timeZone)} to ${fmt(new Date(option.startsAt), timeZone)} (${timeZone})`);
      await expect(card).toContainText(`clearing its overlap with "${googleTitle}"`);
      // The approval surface says what approval cannot do: local copy only,
      // the provider unchanged, nobody notified.
      await expect(card).toContainText("Only the Polymath copy moves - Google Calendar stays unchanged and nobody is notified.");
      // Nothing for the Google event was proposed.
      await expect(page.getByRole("list", { name: "Agent proposals" }).getByText(`Move event: ${googleTitle}`)).toHaveCount(0);
      await page.screenshot({ path: `test-results/feature-pixels/calendar-conflict-card-${vp.name}.png`, style: HIDE_DEV_CHROME });

      // Rejecting records the decision and moves nothing.
      await card.getByRole("button", { name: "Reject" }).click();
      await expect(page.getByText("Rejected.")).toBeVisible();
      const [row] = await sql<{ starts_at: Date; version: number }[]>`select starts_at, version from events where id = ${local.id}`;
      expect(row.starts_at.toISOString()).toBe(at(15).toISOString());
      expect(row.version).toBe(local.version);
    } finally {
      // Only the ids this attempt created.
      if (created.proposals.length) await sql`delete from action_proposals where id = any(${created.proposals}::uuid[])`;
      if (created.events.length) await sql`delete from events where id = any(${created.events}::uuid[])`;
      if (created.calendars.length) await sql`delete from calendars where id = any(${created.calendars}::uuid[])`;
      if (created.accounts.length) await sql`delete from external_accounts where id = any(${created.accounts}::uuid[])`;
      await sql.end();
    }
  });
}
