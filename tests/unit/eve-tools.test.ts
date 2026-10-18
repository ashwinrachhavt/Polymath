import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRunBySessionRef } from "@/domains/agents/queries";
import { listOpenTasks } from "@/domains/work/queries";
import { createProposal } from "@/domains/actions/commands";
import tasksDefinition from "../../eve/alfred/agent/tools/tasks_read";
import gmailDefinition from "../../eve/alfred/agent/tools/gmail_send";

vi.mock("eve/tools", () => ({ defineTool: (definition: unknown) => definition }));
vi.mock("@/domains/agents/queries", () => ({ getRunBySessionRef: vi.fn() }));
vi.mock("@/domains/work/queries", () => ({ listOpenTasks: vi.fn() }));
vi.mock("@/domains/actions/commands", () => ({ createProposal: vi.fn() }));
vi.mock("@/lib/db-transaction", () => ({ withTransaction: (fn: (tx: object) => Promise<unknown>) => fn({}) }));

const sessionId = "wrun_fixture-session";
const workspaceId = "c1c47ca8-e004-46ab-bcdb-c24c4a4a02c7";
const runId = "5a8ea08e-126a-4f81-82d6-4be5fe885d65";
const ctx = { session: { id: sessionId, auth: { current: { attributes: { workspaceId } } } } };
type Context = typeof ctx;
// Exercise authored handlers without Eve's unrelated SDK context/services.
// SQL binding and tenancy invariants have a separate real-Postgres suite.
const tasks = tasksDefinition as unknown as { execute(input: { limit?: number }, ctx: Context): Promise<unknown> };
const gmail = gmailDefinition as unknown as { execute(input: typeof email, ctx: Context): Promise<unknown> };
const email = { to: "recipient@example.test", subject: "Fixture", body: "Review me", messageId: "msg-fixture" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRunBySessionRef).mockResolvedValue({
    id: runId, state: "running", policySnapshot: { allowedTools: ["tasks.read", "gmail.send"] },
  });
  vi.mocked(listOpenTasks).mockResolvedValue([{ id: "task-1", title: "Canonical task", status: "ready", priority: "high", dueAt: null }]);
  vi.mocked(createProposal).mockResolvedValue({ proposalId: "proposal-1", deduplicated: false });
});

describe("Eve tools bind through the persisted session reference", () => {
  it("reads real canonical tasks with the session workspace and frozen policy", async () => {
    expect(await tasks.execute({ limit: 7 }, ctx)).toMatchObject({ ok: true, tasks: [{ title: "Canonical task" }], limit: 7 });
    expect(getRunBySessionRef).toHaveBeenCalledWith(sessionId, workspaceId);
    expect(listOpenTasks).toHaveBeenCalledWith({ workspaceId }, 7);
  });

  it("writes the resolved run UUID into a review proposal, never the wrun session id", async () => {
    expect(await gmail.execute(email, ctx)).toMatchObject({ ok: true, status: "awaiting review" });
    expect(getRunBySessionRef).toHaveBeenCalledWith(sessionId, workspaceId);
    expect(createProposal).toHaveBeenCalledWith(expect.anything(), { workspaceId }, expect.objectContaining({
      runId, capability: "gmail.send", riskClass: "external_write", dedupeKey: `gmail.send:${workspaceId}:msg-fixture`,
    }));
  });

  it("unbound/foreign sessions cannot read tasks or create proposals", async () => {
    vi.mocked(getRunBySessionRef).mockResolvedValue(null);
    expect(await tasks.execute({}, ctx)).toMatchObject({ ok: false });
    expect(await gmail.execute(email, ctx)).toMatchObject({ ok: false });
    expect(listOpenTasks).not.toHaveBeenCalled();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("a bound run still cannot escape its captured allowlist", async () => {
    vi.mocked(getRunBySessionRef).mockResolvedValue({ id: runId, state: "running", policySnapshot: { allowedTools: [] } });
    expect(await tasks.execute({}, ctx)).toMatchObject({ ok: false });
    expect(await gmail.execute(email, ctx)).toMatchObject({ ok: false });
    expect(listOpenTasks).not.toHaveBeenCalled();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("terminal runs cannot use tools even if the old snapshot allowed them", async () => {
    vi.mocked(getRunBySessionRef).mockResolvedValue({ id: runId, state: "cancelled", policySnapshot: { allowedTools: ["tasks.read", "gmail.send"] } });
    expect(await tasks.execute({}, ctx)).toMatchObject({ ok: false });
    expect(await gmail.execute(email, ctx)).toMatchObject({ ok: false });
    expect(listOpenTasks).not.toHaveBeenCalled();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("missing authenticated workspace attributes fail closed before lookup", async () => {
    const anonymous = { session: { ...ctx.session, auth: { current: { attributes: {} } } } } as Context;
    expect(await tasks.execute({}, anonymous)).toMatchObject({ ok: false });
    expect(await gmail.execute(email, anonymous)).toMatchObject({ ok: false });
    expect(getRunBySessionRef).not.toHaveBeenCalled();
  });
});
