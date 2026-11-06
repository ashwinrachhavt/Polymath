import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateTag } from "next/cache";
import { invitationsTag, prefsTag, workspacesTag } from "@/lib/cache-tags";

/*
 * Spec W1/verification 3: the shell's chrome reads are cached behind tags
 * (cached-shell-reads assigns cacheTag(prefsTag|workspacesTag)), so a
 * mutation that misses its updateTag leaves stale chrome until the cacheLife
 * expires. A missed tag fails HERE, not in production: each test drives the
 * real action with its domain dependencies mocked and asserts the tag the
 * cached wrapper assigned (asserted through the same builders, so refactoring
 * either side alone breaks this file).
 *
 * The triage feed is intentionally uncached (cached-shell-reads.ts, header
 * comment): the decision queue must reflect freshly written rows on the very
 * next render, so there is no feed tag to expire and no feed-mutation suite
 * here. Question answer/dismiss revalidatePath their run instead.
 *
 * The render-level reflection ("next render uses the new value") is Next's
 * cache runtime obeying the tag; that half is exercised by the perf-budget
 * e2e and the dogfood runs, not by vitest.
 */

const ownerAuth = { userId: "u_1", workspaceId: "w_1", role: "owner" as const };
// RFC 9562 UUIDs: this repo pins Zod 4, whose uuid() checks the version
// nibble [1-8] AND the variant nibble [89ab] - "…-2222-…" is not a UUID.
const QUESTION_ID = "11111111-1111-4111-a111-111111111111";

const dbMock = vi.hoisted(() => {
  const state = { rows: [] as { id: string; runId: string }[] };
  const chain = {
    set: () => chain,
    where: () => chain,
    returning: async () => state.rows,
  };
  return { state, update: vi.fn(() => chain) };
});
vi.mock("@/lib/db", () => ({ db: dbMock }));

const prefs = vi.hoisted(() => ({ updatePreferences: vi.fn() }));
vi.mock("@/domains/identity/preferences", () => prefs);
const invitations = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  createInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
}));
vi.mock("@/domains/identity/invitations", () => invitations);
const members = vi.hoisted(() => ({ selfMembership: vi.fn() }));
vi.mock("@/domains/identity/members", () => members);
const agentQueries = vi.hoisted(() => ({ getDefaultProfile: vi.fn() }));
vi.mock("@/domains/agents/queries", () => agentQueries);
const agentCommands = vi.hoisted(() => ({ updateDefaultProfileBrief: vi.fn() }));
vi.mock("@/domains/agents/commands", () => agentCommands);
const thread = vi.hoisted(() => ({ sendFollowUp: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/domains/agents/thread", () => thread);
const sessionEmail = vi.hoisted(() => ({ sessionVerifiedEmail: vi.fn(async () => "dad@example.com") }));
vi.mock("@/app/(workspace)/invitations/[token]/session-email", () => sessionEmail);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));

const getAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  return { ...original, getAuthContext };
});

beforeEach(() => {
  // Shared workers reuse the module registry across files (see
  // settings-actions.test.ts): the action modules would come back bound to
  // whatever mocks the first importing file installed. Re-import per test so
  // this file's mocks are the ones the actions actually see.
  vi.resetModules();
  vi.clearAllMocks();
  dbMock.state.rows = [];
  getAuthContext.mockResolvedValue(ownerAuth);
});

describe("workspace mutations expire their shell cache tags", () => {
  it("a mutation that changed nothing expires nothing", async () => {
    // The card was already answered in another tab: no state changed, so
    // firing any tag would be a lie about what the next render will show.
    const { dismissQuestionAction } = await import("@/app/(workspace)/polymath/[runId]/question-actions");
    const result = await dismissQuestionAction({ questionId: QUESTION_ID });
    expect(result.ok).toBe(false);
    expect(updateTag).not.toHaveBeenCalled();
  });
});

describe("a preference write expires the prefs tag", () => {
  it("saving preferences expires the caller's workspace+user prefs tag", async () => {
    prefs.updatePreferences.mockResolvedValue({ timezone: "Europe/Berlin", version: 4 });
    const { savePreferencesAction } = await import("@/app/(workspace)/settings/actions");
    const result = await savePreferencesAction({ timezone: "Europe/Berlin", expectedVersion: 3 });
    expect(result.ok).toBe(true);
    expect(updateTag).toHaveBeenCalledWith(prefsTag(ownerAuth));
  });
});

describe("membership and invitation changes expire the switcher tags", () => {
  it("creating an invitation expires exactly the invitee's mailbox tag", async () => {
    invitations.createInvitation.mockResolvedValue({ invitationId: "i1", token: "tok", expiresAt: new Date() });
    const { createInvitationAction } = await import("@/app/(workspace)/settings/actions");
    const result = await createInvitationAction({ email: "Dad@Example.com" });
    expect(result.ok).toBe(true);
    expect(updateTag).toHaveBeenCalledWith(invitationsTag("Dad@Example.com"));
  });

  it("revoking an invitation expires the mailbox only when something was revoked", async () => {
    invitations.revokeInvitation.mockResolvedValue({ revoked: true, email: "dad@example.com" });
    const { revokeInvitationAction } = await import("@/app/(workspace)/settings/actions");
    const result = await revokeInvitationAction("33333333-3333-3333-3333-333333333333");
    expect(result).toEqual({ ok: true, revoked: true });
    expect(updateTag).toHaveBeenCalledWith(invitationsTag("dad@example.com"));

    vi.clearAllMocks();
    invitations.revokeInvitation.mockResolvedValue({ revoked: false });
    const second = await revokeInvitationAction("33333333-3333-3333-3333-333333333333");
    expect(second).toEqual({ ok: true, revoked: false });
    expect(updateTag).not.toHaveBeenCalled();
  });

  it("accepting an invitation puts the new membership on the acceptor's next render", async () => {
    invitations.acceptInvitation.mockResolvedValue({ workspaceId: "w_9", role: "member", replayed: false });
    const { acceptInvitationAction } = await import("@/app/(workspace)/invitations/[token]/actions");
    const result = await acceptInvitationAction("tok");
    expect(result).toEqual({ ok: true, workspaceId: "w_9", role: "member", replayed: false });
    expect(updateTag).toHaveBeenCalledWith(workspacesTag(ownerAuth.userId));
  });
});
