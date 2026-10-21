import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadPinnedSkill: vi.fn() }));

vi.mock("@/domains/skills/queries", () => ({ loadPinnedSkill: mocks.loadPinnedSkill }));

const { default: resolver } = await import("../../eve/alfred/agent/skills/polymath_skill");

type Attributes = Record<string, string>;
/** The resolver's only handler, plus a context shaped the way eve hands it over. */
const events = (resolver as unknown as {
  events: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
}).events;

function ctx(input: { attributes?: Attributes; initiatorAttributes?: Attributes }) {
  const snapshot = (attributes: Attributes | undefined) =>
    attributes ? { attributes, authenticator: "axiom-bridge", principalId: "u1", principalType: "user" } : null;
  return {
    session: {
      id: "wrun_1",
      auth: {
        current: snapshot(input.attributes),
        initiator: snapshot(input.initiatorAttributes),
      },
    },
  };
}

const resolve = (context: unknown) => events["session.started"]({}, context);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe("the pinned-skill resolver", () => {
  it("returns null without a skillId, quietly: an unpinned run is the normal path", async () => {
    expect(await resolve(ctx({ attributes: { workspaceId: "ws-1", runId: "run-1" } }))).toBeNull();
    expect(mocks.loadPinnedSkill).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns null and warns when a pinned skill no longer resolves (a foreign id behaves the same)", async () => {
    mocks.loadPinnedSkill.mockResolvedValueOnce(null);
    expect(await resolve(ctx({ attributes: { workspaceId: "ws-1", runId: "run-1", skillId: "s1" } }))).toBeNull();
    expect(mocks.loadPinnedSkill).toHaveBeenCalledWith("ws-1", "s1");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("converts stored files to the path-keyed package defineSkill expects", async () => {
    mocks.loadPinnedSkill.mockResolvedValueOnce({
      description: "Release checklist",
      body: "# Release\n\nRun the checks.",
      files: [
        { path: "references/checklist.md", text: "- ships\n" },
        { path: "scripts/run.sh", text: "echo hi\n" },
      ],
    });
    const skill = await resolve(ctx({ attributes: { workspaceId: "ws-1", runId: "run-1", skillId: "s1" } }));
    expect(skill).toMatchObject({
      description: "Release checklist",
      markdown: "# Release\n\nRun the checks.",
      files: { "references/checklist.md": "- ships\n", "scripts/run.sh": "echo hi\n" },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads the creator's pin on a later turn rather than the active caller's", async () => {
    mocks.loadPinnedSkill.mockResolvedValueOnce({ description: "d", body: "b", files: [] });
    // The follow-up's token carries no claims; the initiator's does.
    const skill = await resolve(
      ctx({
        attributes: { workspaceId: "ws-1" },
        initiatorAttributes: { workspaceId: "ws-1", runId: "run-1", skillId: "s1" },
      }),
    );
    expect(skill).toMatchObject({ description: "d" });
    expect(mocks.loadPinnedSkill).toHaveBeenCalledWith("ws-1", "s1");
  });

  it("degrades to null and logs when the lookup throws or a row is malformed", async () => {
    mocks.loadPinnedSkill.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await resolve(ctx({ attributes: { workspaceId: "ws-1", runId: "run-1", skillId: "s1" } }))).toBeNull();

    mocks.loadPinnedSkill.mockResolvedValueOnce({
      description: "d",
      body: "b",
      files: "not-an-array" as unknown as [],
    });
    expect(await resolve(ctx({ attributes: { workspaceId: "ws-1", runId: "run-1", skillId: "s1" } }))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
