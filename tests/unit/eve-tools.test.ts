import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRunBySessionRef } from "@/domains/agents/queries";
import { listOpenTasks } from "@/domains/work/queries";
import tasksDefinition from "../../eve/alfred/agent/tools/tasks_read";
import linearDefinition from "../../eve/alfred/agent/tools/linear_issue_propose";
import { draftLinearIssueFromText } from "@/domains/capture/linear-issue-proposal";

vi.mock("eve/tools", () => ({ defineTool: (definition: unknown) => definition }));
vi.mock("@/domains/agents/queries", () => ({ getRunBySessionRef: vi.fn() }));
vi.mock("@/domains/work/queries", () => ({ listOpenTasks: vi.fn() }));
vi.mock("@/domains/capture/linear-issue-proposal", () => ({
  draftLinearIssueFromText: vi.fn(),
  LinearIssueNoteError: class LinearIssueNoteError extends Error {},
}));

const sessionId = "wrun_fixture-session";
const workspaceId = "c1c47ca8-e004-46ab-bcdb-c24c4a4a02c7";
const runId = "5a8ea08e-126a-4f81-82d6-4be5fe885d65";
const ctx = { session: { id: sessionId, auth: { current: { attributes: { workspaceId } } } } };
type Context = typeof ctx;
// Exercise authored handlers without Eve's unrelated SDK context/services.
// SQL binding and tenancy invariants have a separate real-Postgres suite.
const tasks = tasksDefinition as unknown as { execute(input: { limit?: number }, ctx: Context): Promise<unknown> };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRunBySessionRef).mockResolvedValue({
    id: runId, state: "running", policySnapshot: { allowedTools: ["tasks.read"] },
  });
  vi.mocked(listOpenTasks).mockResolvedValue([{ id: "task-1", title: "Canonical task", status: "ready", priority: "high", dueAt: null }]);
});

describe("Eve tools bind through the persisted session reference", () => {
  it("reads real canonical tasks with the session workspace and frozen policy", async () => {
    expect(await tasks.execute({ limit: 7 }, ctx)).toMatchObject({ ok: true, tasks: [{ title: "Canonical task" }], limit: 7 });
    expect(getRunBySessionRef).toHaveBeenCalledWith(sessionId, workspaceId);
    expect(listOpenTasks).toHaveBeenCalledWith({ workspaceId }, 7);
  });

  it("unbound/foreign sessions cannot read tasks", async () => {
    vi.mocked(getRunBySessionRef).mockResolvedValue(null);
    expect(await tasks.execute({}, ctx)).toMatchObject({ ok: false });
    expect(listOpenTasks).not.toHaveBeenCalled();
  });

  it("a bound run still cannot escape its captured allowlist", async () => {
    vi.mocked(getRunBySessionRef).mockResolvedValue({ id: runId, state: "running", policySnapshot: { allowedTools: [] } });
    expect(await tasks.execute({}, ctx)).toMatchObject({ ok: false });
    expect(listOpenTasks).not.toHaveBeenCalled();
  });

  it("terminal runs cannot use tools even if the old snapshot allowed them", async () => {
    vi.mocked(getRunBySessionRef).mockResolvedValue({ id: runId, state: "cancelled", policySnapshot: { allowedTools: ["tasks.read"] } });
    expect(await tasks.execute({}, ctx)).toMatchObject({ ok: false });
    expect(listOpenTasks).not.toHaveBeenCalled();
  });

  it("missing authenticated workspace attributes fail closed before lookup", async () => {
    const anonymous = { session: { ...ctx.session, auth: { current: { attributes: {} } } } } as Context;
    expect(await tasks.execute({}, anonymous)).toMatchObject({ ok: false });
    expect(getRunBySessionRef).not.toHaveBeenCalled();
  });
});

/*
 * ASH-285: the conversation-drafting tool binds the same way - the run comes
 * from the persisted session reference, the capability must be in the frozen
 * snapshot, and the draft's source key is derived from the authenticated
 * session id so a model-chosen dedupeId can only collide inside its own
 * conversation.
 */
describe("linear_issue_propose binds run, policy and caller-owned draft identity", () => {
  const memberCtx = {
    session: { id: sessionId, auth: { current: { principalId: "user_1", attributes: { workspaceId } } } },
  } as unknown as Context;
  const linear = linearDefinition as unknown as {
    execute(input: { title: string; text: string; dedupeId: string }, ctx: Context): Promise<unknown>;
  };
  const input = { title: "Pasted bug report", text: "The badge never clears.", dedupeId: "bug-1" };

  beforeEach(() => {
    vi.mocked(getRunBySessionRef).mockResolvedValue({
      id: runId, state: "running", policySnapshot: { allowedTools: ["linear.issue.propose"] },
    });
    vi.mocked(draftLinearIssueFromText).mockResolvedValue({
      artifactId: "note-1", title: "Draft: badge", generated: true, outcome: "created",
    } as never);
  });

  it("drafts with session-derived source identity and workspace-scoped auth", async () => {
    expect(await linear.execute(input, memberCtx)).toMatchObject({ ok: true });
    expect(getRunBySessionRef).toHaveBeenCalledWith(sessionId, workspaceId);
    expect(vi.mocked(draftLinearIssueFromText).mock.calls[0][0]).toMatchObject({ workspaceId, userId: "user_1" });
    expect(vi.mocked(draftLinearIssueFromText).mock.calls[0][1]).toMatchObject({
      sourceKey: `${sessionId}:bug-1`,
    });
  });

  it("two conversations with the same dedupeId resolve different drafts", async () => {
    const otherCtx = {
      session: { id: "wrun_other-session", auth: { current: { principalId: "user_2", attributes: { workspaceId } } } },
    } as unknown as Context;
    await linear.execute(input, memberCtx);
    await linear.execute(input, otherCtx);
    const keys = vi.mocked(draftLinearIssueFromText).mock.calls.map((c) => (c[1] as { sourceKey: string }).sourceKey);
    expect(keys).toEqual([`${sessionId}:bug-1`, "wrun_other-session:bug-1"]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("draft identity comes from the authenticated session - model input cannot smuggle one", async () => {
    // A dedupeId carrying a forged session/run-looking string stays inert
    // data after the authenticated session prefix; the tool's input schema
    // has no session or run field to impersonate through.
    await linear.execute({ ...input, dedupeId: "wrun_other-session:bug-1" }, memberCtx);
    const key = (vi.mocked(draftLinearIssueFromText).mock.calls[0][1] as { sourceKey: string }).sourceKey;
    expect(key).toBe(`${sessionId}:wrun_other-session:bug-1`);
    expect(key.startsWith(`${sessionId}:`)).toBe(true);
  });

  it("an unbound or foreign session cannot draft", async () => {
    vi.mocked(getRunBySessionRef).mockResolvedValue(null);
    expect(await linear.execute(input, memberCtx)).toMatchObject({ ok: false });
    expect(draftLinearIssueFromText).not.toHaveBeenCalled();
  });

  it("a snapshot without linear.issue.propose cannot draft", async () => {
    vi.mocked(getRunBySessionRef).mockResolvedValue({
      id: runId, state: "running", policySnapshot: { allowedTools: ["tasks.read"] },
    });
    expect(await linear.execute(input, memberCtx)).toMatchObject({ ok: false });
    expect(draftLinearIssueFromText).not.toHaveBeenCalled();
  });

  it("a terminal run cannot draft even when its old snapshot allowed it", async () => {
    vi.mocked(getRunBySessionRef).mockResolvedValue({
      id: runId, state: "completed", policySnapshot: { allowedTools: ["linear.issue.propose"] },
    });
    expect(await linear.execute(input, memberCtx)).toMatchObject({ ok: false });
    expect(draftLinearIssueFromText).not.toHaveBeenCalled();
  });

  it("missing workspace or principal fails closed before any lookup", async () => {
    const noWorkspace = { session: { id: sessionId, auth: { current: { principalId: "user_1", attributes: {} } } } } as unknown as Context;
    const noPrincipal = { session: { id: sessionId, auth: { current: { attributes: { workspaceId } } } } } as unknown as Context;
    expect(await linear.execute(input, noWorkspace)).toMatchObject({ ok: false });
    expect(await linear.execute(input, noPrincipal)).toMatchObject({ ok: false });
    expect(getRunBySessionRef).not.toHaveBeenCalled();
    expect(draftLinearIssueFromText).not.toHaveBeenCalled();
  });
});
