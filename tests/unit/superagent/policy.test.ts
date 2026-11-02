/**
 * The policy module's specs: the version hash, the gate matrix across strengths and accept modes,
 * inferred admission, and revalidation per mandate basis (docs/002), plus the Engine behaviors a
 * version change drives — running assessments discarded and requeued, live mandates untouched.
 */
import { describe, expect, it } from "vitest";
import {
  ADMISSION_DEFAULTS,
  ADMISSION_OPTIONS,
  Engine,
  MemoryRepositories,
  createPolicy,
  defaultPolicyConfig,
  policyVersion,
  type AcceptMode,
  type Assessor,
  type Candidate,
  type Executor,
  type GateResult,
  type Mandate,
  type MandateBasis,
  type Outbox,
  type Outcome,
  type PolicyConfig,
  type PolicyRule,
  type SourcePolicy,
  type SourceScope,
  type Trigger,
  type WorkThread,
} from "@/domains/superagent/core";

const member = { source: "chat", id: "alice" };
const guest = { source: "chat", id: "guest" };
const MODES = ["off", "observe", "auto"] as const satisfies readonly AcceptMode[];

function rule(id: string, overrides: Partial<PolicyRule> = {}): PolicyRule {
  return { id, name: `Rule ${id}`, enabled: true, instruction: `Do ${id}.`, ...overrides };
}
function chat(overrides: Partial<SourcePolicy> = {}): SourcePolicy {
  return { allowed: [{ id: "alice" }], bots: [], admission: {}, ...overrides };
}
function config(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  // The working baseline: alice is listed. Scenarios needing a different Source pass `sources`.
  return { ...defaultPolicyConfig(), sources: { chat: chat() }, ...overrides };
}
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: "chat",
    threads: [{ source: "chat", id: "t1" }],
    actor: member,
    human: true,
    at: `2026-09-23T00:00:${id.padStart(2, "0")}Z`,
    text: `message ${id}`,
    meta: {},
    ...overrides,
  };
}
function thread(subscriptions: string[] = [], context: string[] = []): WorkThread {
  return {
    key: "chat:t1",
    ref: { source: "chat", id: "t1" },
    createdAt: "2026-09-23T00:00:00.000Z",
    subscriptions,
    correlated: [],
    pending: [],
    meta: {},
    ...(context.length ? { context } : {}),
  };
}
/** A Source whose receiving scopes the triggers' meta names: `row` picks the admission row, `observed` says it receives every message, `blocked` stops listening. */
const scope: SourceScope = {
  scope: ({ meta }) =>
    meta.blocked
      ? { listened: false, reason: "chat not allowed" }
      : {
          listened: true,
          observed: !!meta.observed,
          ...(typeof meta.row === "string" ? { row: meta.row } : {}),
        },
};
const policy = (overrides: Partial<PolicyConfig> = {}): ReturnType<typeof createPolicy> =>
  createPolicy(config(overrides), scope);
function admissible(result: GateResult): Extract<GateResult, { admissible: true }> {
  if (!result.admissible) throw new Error(`expected admissible, refused: ${result.reason}`);
  return result;
}
const refused = (result: GateResult): string => {
  if (result.admissible) throw new Error("expected refusal");
  return result.reason;
};

describe("policy version", () => {
  it("is stable for equal configs, whatever order their keys were built in", () => {
    const built = config({ mode: "auto", rules: [rule("triage")], sources: { chat: chat() } });
    const shifted: PolicyConfig = {
      sources: built.sources,
      evalTimeoutMs: built.evalTimeoutMs,
      rules: built.rules,
      mode: built.mode,
      paused: built.paused,
    };
    expect(policyVersion(built)).toBe(
      policyVersion(config({ mode: "auto", rules: [rule("triage")], sources: { chat: chat() } })),
    );
    expect(policyVersion(shifted)).toBe(policyVersion(built));
  });
  it("changes with the rules, the accept mode, and each Source's part", () => {
    const base = config({ mode: "auto", rules: [rule("triage")], sources: { chat: chat() } });
    const changed = (overrides: Partial<PolicyConfig>): string =>
      policyVersion(config({ ...{ mode: "auto", rules: [rule("triage")], sources: { chat: chat() } }, ...overrides }));
    expect(policyVersion(base)).not.toBe(changed({ rules: [rule("triage"), rule("other")] }));
    expect(policyVersion(base)).not.toBe(changed({ rules: [{ ...rule("triage"), instruction: "Changed." }] }));
    expect(policyVersion(base)).not.toBe(changed({ rules: [{ ...rule("triage"), enabled: false }] }));
    expect(policyVersion(base)).not.toBe(changed({ mode: "observe" }));
    expect(policyVersion(base)).not.toBe(changed({ sources: { chat: chat({ allowed: [] }) } }));
    expect(policyVersion(base)).not.toBe(changed({ sources: { chat: chat({ bots: [{ id: "ci-bot" }] }) } }));
    expect(policyVersion(base)).not.toBe(
      changed({ sources: { chat: chat({ admission: { support: { unlistedAddressed: "explicit" } } }) } }),
    );
  });
  it("does not change with the pause state or the eval timeout, which change no mandate's meaning", () => {
    const base = policyVersion(config());
    expect(policyVersion(config({ paused: true }))).toBe(base);
    expect(policyVersion(config({ evalTimeoutMs: 60_000 }))).toBe(base);
    expect(policy().paused).toBe(false);
    expect(policy({ paused: true }).paused).toBe(true);
    expect(policy({ evalTimeoutMs: 60_000 }).evalTimeoutMs).toBe(60_000);
  });
});

describe("gate matrix", () => {
  it("defaults the admission table to pre-table behavior", () => {
    expect(ADMISSION_DEFAULTS).toEqual({
      listedUnaddressed: "inferred",
      unlistedAddressed: "ignore",
      unlistedUnaddressed: "ignore",
    });
    // An unaddressed message can never be explicit.
    expect(ADMISSION_OPTIONS.listedUnaddressed).not.toContain("explicit");
    expect(ADMISSION_OPTIONS.unlistedUnaddressed).not.toContain("explicit");
    expect(ADMISSION_OPTIONS.unlistedAddressed).toContain("explicit");
  });

  it("a listed sender who addresses the agent makes an explicit request in every accept mode", () => {
    for (const mode of MODES)
      for (const addressed of ["mention", "direct"] as const) {
        const result = admissible(policy({ mode }).gate(trigger("1", { addressed }), thread(), []));
        expect(result.strength).toBe("explicit");
        expect(result.basis).toEqual({
          source: "chat",
          scope: {},
          sender: "alice",
          via: "addressed",
          addressed,
        });
      }
  });

  it("a listed sender's follow-up on a thread with tickets is explicit in every accept mode", () => {
    for (const mode of MODES) {
      const result = admissible(
        policy({ mode }).gate(trigger("1", { meta: { row: "support", observed: true } }), thread(["w1"]), []),
      );
      expect(result.strength).toBe("explicit");
      expect(result.basis).toMatchObject({ via: "followup", sender: "alice" });
    }
  });

  it("an unaddressed message from a listed sender elsewhere is an inferred candidate, admitted only when the mode is not off", () => {
    const observed = trigger("1", { meta: { row: "support", observed: true } });
    expect(refused(policy({ mode: "off" }).gate(observed, thread(), []))).toBe("no_mention");
    const result = admissible(policy({ mode: "observe" }).gate(observed, thread(), []));
    expect(result.strength).toBe("inferred");
    expect(result.basis).toMatchObject({
      via: "admission",
      cell: "listedUnaddressed",
      row: "support",
      observation: { mode: "observe" },
    });
  });

  it("an unaddressed message in a mention-only scope never reaches the table", () => {
    expect(refused(policy({ mode: "auto" }).gate(trigger("1"), thread(), []))).toBe("no_mention");
  });

  it("an unlisted sender's addressed message is an inferred follow-up on a ticket thread only when the mode is not off", () => {
    const guestMention = trigger("1", { actor: guest, addressed: "mention" });
    expect(refused(policy({ mode: "off" }).gate(guestMention, thread(["w1"]), []))).toBe("not_a_member");
    const result = admissible(policy({ mode: "observe" }).gate(guestMention, thread(["w1"]), []));
    expect(result.strength).toBe("inferred");
    expect(result.basis).toMatchObject({ via: "followup" });
    expect(refused(policy({ mode: "auto" }).gate(guestMention, thread(), []))).toBe("not_a_member");
  });

  it("an explicit admission cell makes an unlisted sender's addressed request explicit in every mode, ahead of thread follow-ups", () => {
    const table = {
      sources: { chat: chat({ allowed: [], admission: { support: { unlistedAddressed: "explicit" } } }) },
    };
    const guestMention = trigger("1", { actor: guest, addressed: "mention", meta: { row: "support", observed: true } });
    for (const mode of MODES) {
      const result = admissible(policy({ mode, ...table }).gate(guestMention, thread(["w1"]), []));
      expect(result.strength).toBe("explicit");
      expect(result.basis).toMatchObject({ via: "admission", cell: "unlistedAddressed", addressed: "mention" });
    }
  });

  it("a thread followed only for context grants no follow-up strength: the admission table decides instead", () => {
    const contextOnly = thread(["w1"], ["w1"]);
    const guestMention = trigger("1", { actor: guest, addressed: "mention" });
    expect(refused(policy({ mode: "auto" }).gate(guestMention, contextOnly, []))).toBe("not_a_member");
    const listed = trigger("1", { meta: { row: "support", observed: true } });
    const result = admissible(policy({ mode: "auto" }).gate(listed, contextOnly, []));
    expect(result.strength).toBe("inferred");
    expect(result.basis).toMatchObject({ via: "admission", cell: "listedUnaddressed" });
  });

  it("admits a listed bot's message as an inferred candidate at most, never an explicit request", () => {
    const bots = { sources: { chat: chat({ bots: [{ id: "ci-bot" }] }) } };
    for (const addressed of ["mention", "direct"] as const) {
      const bot = trigger("1", { human: false, actor: { source: "chat", id: "ci-bot" }, addressed });
      const result = admissible(policy({ mode: "auto", ...bots }).gate(bot, thread(["w1"]), []));
      expect(result.strength).toBe("inferred");
      expect(result.basis).toMatchObject({ via: "bot", sender: "ci-bot", addressed });
    }
    expect(
      refused(
        policy({ mode: "off", ...bots }).gate(
          trigger("1", { human: false, actor: { source: "chat", id: "ci-bot" }, addressed: "mention" }),
          thread(),
          [],
        ),
      ),
    ).toBe("admission_ignored");
    expect(
      refused(
        policy({ mode: "auto" }).gate(
          trigger("1", { human: false, actor: { source: "chat", id: "other-bot" }, addressed: "mention" }),
          thread(),
          [],
        ),
      ),
    ).toBe("not_human");
  });

  it("admits a senderless event only where the scope observes and the cell is inferred", () => {
    const ci = trigger("1", {
      human: false,
      actor: { source: "chat", id: "" },
      meta: { row: "support", observed: true },
    });
    const inferredCell = { sources: { chat: chat({ admission: { support: { unlistedUnaddressed: "inferred" } } }) } };
    const result = admissible(policy({ mode: "auto", ...inferredCell }).gate(ci, thread(), []));
    expect(result.strength).toBe("inferred");
    expect(result.basis).toMatchObject({ via: "admission", cell: "unlistedUnaddressed", row: "support" });
    expect(refused(policy({ mode: "auto" }).gate(ci, thread(), []))).toBe("admission_ignored");
    expect(refused(policy({ mode: "off", ...inferredCell }).gate(ci, thread(), []))).toBe("admission_ignored");
    expect(
      refused(policy({ mode: "auto", ...inferredCell }).gate({ ...ci, meta: { row: "support" } }, thread(), [])),
    ).toBe("not_human");
  });
});

describe("admitsInferred", () => {
  it("accepts an inferred candidate only in auto mode on enabled matched rules", () => {
    const auto = policy({ mode: "auto", rules: [rule("triage"), { ...rule("off-rule"), enabled: false }] });
    expect(auto.admitsInferred(["triage"])).toBe(true);
    expect(auto.admitsInferred(["triage", "off-rule"])).toBe(false);
    expect(auto.admitsInferred(["unknown"])).toBe(false);
    expect(auto.admitsInferred([])).toBe(false);
    expect(policy({ mode: "observe", rules: [rule("triage")] }).admitsInferred(["triage"])).toBe(false);
    expect(policy({ mode: "off", rules: [rule("triage")] }).admitsInferred(["triage"])).toBe(false);
  });
});

describe("revalidation", () => {
  function mandate(basis: MandateBasis, overrides: Partial<Mandate> = {}): Mandate {
    return { strength: "explicit", policyVersion: "v1", actor: member, scope: "support", ...overrides, basis };
  }

  it("keeps an explicit follow-up mandate without further checks", () => {
    expect(policy().revalidate(mandate({ via: "followup" }))).toBe(true);
  });

  it("requires auto mode and enabled rules for an inferred follow-up mandate", () => {
    const m = mandate({ via: "followup", source: "chat", scope: {}, rules: ["triage"] }, { strength: "inferred" });
    expect(policy({ mode: "observe", rules: [rule("triage")] }).revalidate(m)).toBe(false);
    expect(policy({ mode: "auto", rules: [rule("triage")] }).revalidate(m)).toBe(true);
    expect(policy({ mode: "auto", rules: [{ ...rule("triage"), enabled: false }] }).revalidate(m)).toBe(false);
    expect(policy({ mode: "auto", rules: [rule("other")] }).revalidate(m)).toBe(false);
  });

  it("requires the sender to stay listed for an addressed or legacy listed mandate", () => {
    const addressed = mandate({ via: "addressed", addressed: "mention", source: "chat", scope: {} });
    const listed = mandate({ via: "listed" });
    for (const m of [addressed, listed]) {
      expect(policy().revalidate(m)).toBe(true);
      expect(policy({ sources: { chat: chat({ allowed: [] }) } }).revalidate(m)).toBe(false);
    }
  });

  it("requires auto mode and enabled rules for an observed legacy listed mandate", () => {
    const m = mandate(
      { via: "listed", source: "chat", scope: {}, observation: { mode: "auto" }, rules: ["triage"] },
      { strength: "inferred" },
    );
    expect(policy({ mode: "auto", rules: [rule("triage")] }).revalidate(m)).toBe(true);
    expect(policy({ mode: "observe", rules: [rule("triage")] }).revalidate(m)).toBe(false);
  });

  it("revokes a listed-cell mandate when the sender leaves the allowed list", () => {
    const m = mandate(
      {
        via: "admission",
        cell: "listedUnaddressed",
        source: "chat",
        scope: { row: "support" },
        observation: { mode: "auto" },
        rules: ["triage"],
      },
      { strength: "inferred" },
    );
    expect(policy({ mode: "auto", rules: [rule("triage")] }).revalidate(m)).toBe(true);
    expect(
      policy({ mode: "auto", rules: [rule("triage")], sources: { chat: chat({ allowed: [] }) } }).revalidate(m),
    ).toBe(false);
  });

  it("an admission-cell mandate holds while its cell still grants at least the accepted strength", () => {
    const m = mandate({
      via: "admission",
      cell: "unlistedAddressed",
      addressed: "mention",
      source: "chat",
      scope: { row: "dm" },
    });
    const withCell = (row: Record<string, unknown>): Partial<PolicyConfig> => ({
      sources: { chat: chat({ allowed: [], admission: { dm: row } }) },
    });
    // Still explicit: holds in every accept mode.
    expect(policy({ mode: "off", ...withCell({ unlistedAddressed: "explicit" }) }).revalidate(m)).toBe(true);
    // Weakened to ignore: revoked before any resume.
    expect(policy({ mode: "auto", ...withCell({}) }).revalidate(m)).toBe(false);
    // The sender joined the allowed list since: the addressed-listed pair reads no cell and stays explicit.
    expect(policy({ mode: "off", sources: { chat: chat({ allowed: [{ id: "alice" }] }) } }).revalidate(m)).toBe(true);
  });

  it("a bot mandate holds while the bot stays listed, in auto mode with its rules on", () => {
    const m = mandate(
      {
        via: "bot",
        sender: "ci-bot",
        source: "chat",
        scope: { observed: true },
        observation: { mode: "auto" },
        rules: ["triage"],
      },
      { strength: "inferred", actor: { source: "chat", id: "ci-bot" } },
    );
    const withBot = { sources: { chat: chat({ bots: [{ id: "ci-bot" }] }) } };
    expect(policy({ mode: "auto", rules: [rule("triage")], ...withBot }).revalidate(m)).toBe(true);
    expect(policy({ mode: "auto", rules: [rule("triage")], sources: { chat: chat() } }).revalidate(m)).toBe(false);
    expect(policy({ mode: "observe", rules: [rule("triage")], ...withBot }).revalidate(m)).toBe(false);
    expect(policy({ mode: "off", rules: [rule("triage")], ...withBot }).revalidate(m)).toBe(false);
  });

  it("fails when the Source no longer listens to the recorded scope", () => {
    const m = mandate({ via: "addressed", addressed: "mention", source: "chat", scope: { blocked: true } });
    expect(policy().revalidate(m)).toBe(false);
  });
});

describe("engine version changes", () => {
  function harness(initial: PolicyConfig) {
    let current = initial;
    const repo = new MemoryRepositories();
    const requests: Candidate[] = [];
    const assessor: Assessor = { request: (candidate) => requests.push(candidate) };
    const executor: Executor = { start: () => {}, deliver: () => {}, stop: () => {} };
    const outbox: Outbox = { send: () => {}, status: () => undefined, withdraw: () => {} };
    const engine = new Engine({
      repo,
      scope,
      policy: () => createPolicy(current, scope),
      assessor,
      executor,
      outbox,
      now: () => "2026-09-23T00:00:00.000Z",
    });
    return {
      engine,
      repo,
      requests,
      setConfig: (next: PolicyConfig) => {
        current = next;
      },
      version: () => policyVersion(current),
      policy: () => createPolicy(current, scope),
      decide: (candidate: Candidate, outcome: Outcome) =>
        engine.decide(candidate.triggers[0]!.id, { ...outcome, assessmentId: candidate.assessmentId }),
    };
  }
  const observedTrigger = (): Trigger => trigger("1", { meta: { row: "support", observed: true } });

  it("a version change discards a running assessment and queues its triggers again under the new version", () => {
    const h = harness(config({ mode: "observe", rules: [rule("triage")], sources: { chat: chat() } }));
    const from = h.version();
    h.engine.receive(observedTrigger());
    h.engine.evaluateDue();
    const started = h.repo.threads.get("chat:t1")!;
    expect(started.evaluating?.policyVersion).toBe(from);
    h.setConfig(config({ mode: "auto", rules: [rule("triage")], sources: { chat: chat() } }));
    h.engine.policyChanged(from, h.version());
    const after = h.repo.threads.get("chat:t1")!;
    expect(after.evaluating).toBeUndefined();
    expect(after.pending).toEqual(["1"]);
    const decision = h.repo.decisions.byThread("chat:t1").at(-1)!;
    expect(decision.kind).toBe("unavailable");
    expect(decision.reason).toEqual([{ code: "policyChanged" }]);
    h.engine.evaluateDue();
    expect(h.requests.at(-1)!.policyVersion).toBe(h.version());
    expect(h.requests.at(-1)!.policyVersion).not.toBe(from);
  });

  it("a version change leaves a live ticket's mandate and its work alone when nothing bears on it", () => {
    const h = harness(config({ mode: "auto", rules: [rule("triage")], sources: { chat: chat() } }));
    const from = h.version();
    h.engine.receive(observedTrigger());
    h.engine.evaluateDue();
    const decision = h.decide(h.requests.at(-1)!, {
      kind: "accept",
      title: "Triage",
      scope: "support",
      reason: "matches triage",
      rules: ["triage"],
    });
    const ticketId = decision.ticketId!;
    expect(h.repo.tickets.get(ticketId)!.mandate.policyVersion).toBe(from);
    // An unrelated rule joins: the version changes, the mandate does not.
    h.setConfig(config({ mode: "auto", rules: [rule("triage"), rule("other")], sources: { chat: chat() } }));
    h.engine.policyChanged(from, h.version());
    const ticket = h.repo.tickets.get(ticketId)!;
    expect(ticket.ended).toBeUndefined();
    expect(ticket.mandate.policyVersion).toBe(from);
    expect(ticket.inputs.filter((input) => input.kind === "policy-changed")).toEqual([]);
    expect(h.policy().revalidate(ticket.mandate)).toBe(true);
  });
});
