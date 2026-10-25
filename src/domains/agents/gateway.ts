import { and, count, desc, eq, gte, isNotNull, like, sql } from "drizzle-orm";
import { z } from "zod";
import { toolAllowed } from "../../../eve/alfred/agent/lib/policy";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { createProposal, withSenderAccountPin } from "@/domains/actions/commands";
import { actionRevisions } from "@/domains/actions/schema";
import { decideAndRecordToolInvocation } from "./authorization";
import { draftReply, WriterDraftError, type ResolvedSenderAccount } from "./writer-draft";
import { getDelegationGrant, hashDelegationGrant } from "./delegation";
import { parkRunForReview } from "./event-bridge";
import { toolCalls } from "./schema";
import { CAPABILITIES, LIMITS, PROVIDER_TOOLS, tierAllows, type Capability } from "@/domains/integrations/capabilities";
import { TOOL_SCHEMAS } from "@/domains/integrations/tool-manifest";
import { readGmailThread, searchGmailMessages, type GmailReadFailure } from "@/domains/integrations/gmail/reads";
import { readGithubIssue, searchGithub } from "@/domains/integrations/reads/github";
import { GENERIC_READS, genericList } from "@/domains/integrations/reads/generic";
import { readLinearIssue, searchLinearIssues } from "@/domains/integrations/reads/linear";
import { readNotionPage, searchNotion } from "@/domains/integrations/reads/notion";
import { getInstagramProfile, listInstagramMedia } from "@/domains/integrations/reads/instagram";
import { getLinkedInProfile } from "@/domains/integrations/reads/linkedin";
import { listSlackChannels, readSlackChannel } from "@/domains/integrations/reads/slack";
import type { Transport } from "@/domains/integrations/transport";
import type { AuthContext } from "@/domains/identity/resolve";
import { resolveConnectedAccount } from "@/domains/integrations/queries";
import { projectSubjectOf } from "./queries";
import { projectAccountAllowlist } from "@/domains/knowledge/project-settings";

/*
 * The dispatch half of the provider gateway: one authorized tool invocation
 * becomes either a read or a proposal, never a provider write.
 *
 * The seam is `createGateway({ transport })` so a test can inject a fixture
 * transport and the route can keep the Composio one. Everything below the
 * dispatch line has already passed the route's bindings; everything below the
 * gate line re-reads the state that can change between calls (the run's frozen
 * snapshot, the connected account's status) because a cached verdict would
 * outlive a revocation or a cancellation.
 *
 * A proposal path never touches the transport. That is structural, not a rule
 * someone remembers: the only call sites of a read live in the read branches,
 * and `proposeSend` has no transport in scope.
 */

export type GatewayRun = {
  id: string;
  policySnapshot: unknown;
  /** The subjects the run is bound to; a project subject scopes its connectors. */
  subjects?: unknown;
};

export type GatewayContext = {
  auth: AuthContext;
  run: GatewayRun;
  tool: string;
  args: unknown;
  now?: Date;
};

export type ToolResult = { content: Array<{ type: "text"; text: string }> };

/**
 * How many identical calls one run may make before it is parked. Two is a
 * retry; three is a loop.
 */
const LOOP_CALL_THRESHOLD = 3;

export type GatewayOutcome =
  | { ok: true; result: ToolResult }
  | { ok: false; status: number; code: string; message: string };

type SearchArgs = z.infer<typeof TOOL_SCHEMAS.gmail_search>;
type ThreadArgs = z.infer<typeof TOOL_SCHEMAS.gmail_read_thread>;
type SendArgs = z.infer<typeof TOOL_SCHEMAS.gmail_send>;

/*
 * `resourceRef` is the "kind:uuid" shape the grant registry uses. A thread read
 * names the thread, so a grant bounded to `thread:<id>` actually narrows the
 * read: without it the bound is skipped and delegation stops narrowing, which
 * is a stated invariant rather than a nicety.
 */
type ParsedSearch = { ok: true; generic?: undefined; tool: "gmail_search"; args: SearchArgs; accountAlias?: string; destination?: string };
type ParsedThread = {
  ok: true;
  generic?: undefined;
  tool: "gmail_read_thread";
  args: ThreadArgs;
  accountAlias?: string;
  destination?: string;
  resourceRef: string;
};
type ParsedSend = { ok: true; generic?: undefined; tool: "gmail_send"; args: SendArgs; accountAlias?: string; destination: string };
type ParsedWriterDraft = {
  ok: true;
  generic?: undefined;
  tool: "writer_draft_reply";
  args: { threadId: string; instruction?: string };
  accountAlias?: string;
  destination?: undefined;
  resourceRef?: string;
};

const OTHER_READS = [
  "github_search",
  "github_read_issue",
  "slack_list_channels",
  "slack_read_channel",
  "linear_search_issues",
  "linear_read_issue",
  "notion_search",
  "notion_read_page",
  "linkedin_get_profile",
  "instagram_get_profile",
  "instagram_list_media",
] as const;
type OtherRead = (typeof OTHER_READS)[number];
type ParsedGeneric = {
  ok: true;
  generic: true;
  tool: string;
  args: { query?: string; limit?: number; accountAlias?: string };
  accountAlias?: string;
  destination?: undefined;
  resourceRef?: string;
};

type ParsedOther = {
  ok: true;
  generic?: undefined;
  tool: OtherRead;
  args: Record<string, unknown>;
  accountAlias?: string;
  destination?: undefined;
  resourceRef?: string;
};

type ParsedCall = ParsedSearch | ParsedThread | ParsedSend | ParsedWriterDraft | ParsedOther | ParsedGeneric | { ok: false; message: string };

function invalidArguments(message: string): GatewayOutcome {
  return { ok: false, status: 400, code: "invalid_arguments", message };
}

/*
 * `limit` is clamped, not rejected. A model asking for 1000 asked for "as many
 * as you have"; an error teaches it nothing, while 100 is the contract the
 * manifest publishes. The clamp runs before validation so the shared manifest
 * schema stays the single description of the arguments.
 */
function normaliseLimit(raw: Record<string, unknown>): Record<string, unknown> {
  if (!("limit" in raw)) return raw;
  const value = raw.limit;
  if (typeof value !== "number" || !Number.isFinite(value)) return raw;
  return { ...raw, limit: Math.min(Math.max(Math.trunc(value), 1), LIMITS.maxResults) };
}

function parseCall(tool: string, input: unknown): ParsedCall {
  const raw = input !== null && typeof input === "object" ? normaliseLimit({ ...(input as Record<string, unknown>) }) : {};
  const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? "Invalid arguments.";

  if (tool === "gmail_search") {
    const parsed = TOOL_SCHEMAS.gmail_search.safeParse(raw);
    return parsed.success
      ? { ok: true, tool: "gmail_search", args: parsed.data, accountAlias: parsed.data.accountAlias }
      : { ok: false, message: firstIssue(parsed.error) };
  }
  if (tool === "writer_draft_reply") {
    const parsed = TOOL_SCHEMAS.writer_draft_reply.safeParse(raw);
    return parsed.success
      ? {
          ok: true as const,
          tool: "writer_draft_reply" as const,
          args: { threadId: parsed.data.threadId, instruction: parsed.data.instruction },
          accountAlias: parsed.data.accountAlias,
          resourceRef: `thread:${parsed.data.threadId}`,
        }
      : { ok: false as const, message: firstIssue(parsed.error) };
  }
  if (tool === "gmail_read_thread") {
    const parsed = TOOL_SCHEMAS.gmail_read_thread.safeParse(raw);
    return parsed.success
      ? {
          ok: true,
          tool: "gmail_read_thread",
          args: parsed.data,
          accountAlias: parsed.data.accountAlias,
          resourceRef: `thread:${parsed.data.threadId}`,
        }
      : { ok: false, message: firstIssue(parsed.error) };
  }
  if (tool in GENERIC_READS) {
    const parsed = z
      .object({
        query: z.string().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(LIMITS.maxResults).optional(),
        accountAlias: z.string().optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
    return { ok: true, generic: true as const, tool, args: parsed.data, accountAlias: parsed.data.accountAlias };
  }
  if ((OTHER_READS as readonly string[]).includes(tool)) {
    const name = tool as OtherRead;
    const parsed = TOOL_SCHEMAS[name].safeParse(raw);
    if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
    const args = parsed.data as Record<string, unknown>;
    return {
      ok: true,
      tool: name,
      args,
      accountAlias: typeof args.accountAlias === "string" ? args.accountAlias : undefined,
      // A named issue narrows a grant the same way a named thread does.
      resourceRef:
        name === "github_read_issue"
          ? `issue:${args.owner}/${args.repo}#${args.number}`
          : name === "linear_read_issue"
            ? `issue:linear:${String(args.identifier).toUpperCase()}`
            : name === "notion_read_page"
              ? `page:notion:${args.pageId}`
            : undefined,
    };
  }
  const parsed = TOOL_SCHEMAS.gmail_send.safeParse(raw);
  return parsed.success
    ? { ok: true, tool: "gmail_send", args: parsed.data, accountAlias: parsed.data.accountAlias, destination: parsed.data.to }
    : { ok: false, message: firstIssue(parsed.error) };
}

function grantIdFrom(snapshot: unknown): string | null {
  const value = (snapshot as { grantId?: unknown } | null | undefined)?.grantId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function snapshotCeiling(snapshot: unknown): string[] | undefined {
  const value = (snapshot as { allowedTools?: unknown } | null | undefined)?.allowedTools;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

/*
 * The grant verdict, written in the caller's short transaction. No transaction
 * spans a provider call, so this one closes before any read is dispatched.
 *
 * When the run names no grant - every run made before grants are issued - no
 * call reaches this function: `agent_authorization_decisions.grant_id` is NOT
 * NULL, so a grantless verdict has no row it could honestly inhabit. The
 * snapshot and the bindings are the whole gate for those runs; the gap is
 * recorded in the plan's open questions and in this module's report.
 */
async function recordGrantDecision(
  context: GatewayContext,
  grantId: string,
  capability: Capability,
  parsed: ParsedCall & { ok: true },
  accountAlias: string | undefined,
): Promise<{ allowed: boolean; reasons: string[] }> {
  const now = context.now ?? new Date();
  const profileCeiling = snapshotCeiling(context.run.policySnapshot);

  return withTransaction(async (tx) => {
    const grant = await getDelegationGrant(tx, context.auth.workspaceId, grantId);
    // A snapshot naming a grant this workspace does not hold cannot be verified;
    // it denies rather than falling back to snapshot-only authority.
    if (!grant) return { allowed: false, reasons: ["grant_not_found"] };

    const expectedContentHash = await hashDelegationGrant(grant);
    const decision = await decideAndRecordToolInvocation(tx, {
      workspaceId: context.auth.workspaceId,
      grantId,
      agentPrincipalId: grant.agentPrincipalId,
      runId: context.run.id,
      grant,
      request: {
        operation: capability,
        accountAlias,
        resourceRef: "resourceRef" in parsed ? parsed.resourceRef : undefined,
        destination: parsed.destination,
        profileCeiling,
        now,
        expectedContentHash,
      },
    });
    return decision.allowed
      ? { allowed: true, reasons: [] }
      : { allowed: false, reasons: decision.reasons };
  });
}

/*
 * The reservation half of the limits. Counting committed rows and dispatching
 * afterwards is a TOCTOU window: N concurrent calls all read 49 of 50 and all
 * proceed, so the cap is not a cap. Instead one transaction takes a workspace
 * advisory lock, counts, and inserts the pending `tool_calls` row, which is the
 * reservation the next caller counts. The lock serializes gateway calls per
 * workspace, which is the correct ceiling at this scale: one person, one run.
 *
 * A reservation that never settles (a crash between insert and update) keeps
 * counting. That is deliberate: spending the budget wrongly is recoverable,
 * exceeding it is not.
 */
async function reserveCall(
  context: GatewayContext,
  provider: string,
  parsed: ParsedCall & { ok: true },
  accountAlias: string,
): Promise<{ ok: true; reservationId: string; startedAt: number } | { ok: false; outcome: GatewayOutcome }> {
  const now = context.now ?? new Date();
  const since = new Date(now.getTime() - 60_000);
  const startedAt = Date.now();

  return withTransaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`gateway_limits:${context.auth.workspaceId}`}, 0))`,
    );
    const [runRows, workspaceRows] = await Promise.all([
      tx
        .select({ n: count() })
        .from(toolCalls)
        .where(
          and(
            eq(toolCalls.workspaceId, context.auth.workspaceId),
            eq(toolCalls.runId, context.run.id),
            like(toolCalls.toolName, `${provider}_%`),
          ),
        ),
      tx
        .select({ n: count() })
        .from(toolCalls)
        .where(and(eq(toolCalls.workspaceId, context.auth.workspaceId), gte(toolCalls.createdAt, since))),
    ]);

    if (Number(runRows[0]?.n ?? 0) >= LIMITS.callsPerRunPerProvider) {
      return {
        ok: false as const,
        outcome: {
          ok: false as const,
          status: 429,
          code: "run_capability_limit",
          message: `This run has used its provider calls for ${provider === "gmail" ? "Gmail" : provider === "github" ? "GitHub" : provider === "linear" ? "Linear" : "Slack"}.`,
        },
      };
    }
    if (Number(workspaceRows[0]?.n ?? 0) >= LIMITS.callsPerWorkspacePerMinute) {
      return {
        ok: false as const,
        outcome: {
          ok: false as const,
          status: 429,
          code: "workspace_rate_limit",
          message: "This workspace is calling providers too quickly. Try again in a minute.",
        },
      };
    }

    const [row] = await tx
      .insert(toolCalls)
      .values({
        workspaceId: context.auth.workspaceId,
        runId: context.run.id,
        toolName: parsed.tool,
        accountAlias,
        arguments: redactArguments(parsed),
        ok: null,
      })
      .returning({ id: toolCalls.id });
    return { ok: true as const, reservationId: row.id, startedAt };
  });
}

/*
 * Arguments are redacted before they land in `tool_calls`: the row exists to
 * count and to explain, and an outbound body copied here would be a second
 * copy of content the proposal already owns.
 */
function redactArguments(parsed: ParsedCall & { ok: true }): Record<string, unknown> {
  if (parsed.generic) return { query: parsed.args.query, limit: parsed.args.limit ?? LIMITS.defaultResults };
  if (parsed.tool === "gmail_search") return { query: parsed.args.query, limit: parsed.args.limit ?? LIMITS.defaultResults };
  if (parsed.tool === "gmail_read_thread" || parsed.tool === "writer_draft_reply") return { threadId: parsed.args.threadId };
  if (parsed.tool !== "gmail_send") {
    // Reads of other providers: the arguments are queries and ids, never bodies.
    const { accountAlias: _alias, ...rest } = parsed.args as Record<string, unknown>;
    void _alias;
    return rest;
  }
  return {
    to: parsed.args.to,
    subject: parsed.args.subject,
    messageId: parsed.args.messageId,
    hasBody: parsed.args.body.length > 0,
  };
}

/*
 * The settlement half. A reservation is written before dispatch and updated
 * after, so a failure still leaves a settled row rather than a dangling
 * pending one, and the duration is real rather than re-measured.
 */
async function settleCall(
  reservationId: string,
  values: {
    ok: boolean;
    errorCode?: string;
    result?: Record<string, unknown>;
    durationMs: number;
  },
): Promise<void> {
  await db
    .update(toolCalls)
    .set({
      ok: values.ok,
      result: values.result ?? null,
      errorCode: values.errorCode ?? null,
      durationMs: values.durationMs,
    })
    .where(eq(toolCalls.id, reservationId));
}

/*
 * Truncation keeps whole messages: a half-serialised record is a claim with its
 * evidence cut off. The marker is part of the payload the model reads, so an
 * incomplete answer can never look complete.
 */
function truncateMessages(messages: readonly unknown[], maxBytes: number): { text: string; truncated: boolean } {
  const full = JSON.stringify({ messages });
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return { text: full, truncated: false };

  const kept: unknown[] = [];
  // The width of the marker's largest possible `returnedBytes` (maxBytes is
  // five digits or fewer). Reserving it means the fit check cannot pass on a
  // payload that the final marker then pushes over the bound.
  const widestMarker = Number("9".repeat(String(maxBytes).length));
  for (const message of messages) {
    if (
      Buffer.byteLength(JSON.stringify({ messages: [...kept, message], truncated: true, returnedBytes: widestMarker }), "utf8") >
      maxBytes
    ) {
      break;
    }
    kept.push(message);
  }
  // The marker reports its own final size, so the number the model reads is the
  // payload's size rather than one digit short of it. Writing the number changes
  // the number of digits, so it is recomputed until the count stops moving.
  let returnedBytes = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const size = Buffer.byteLength(JSON.stringify({ messages: kept, truncated: true, returnedBytes }), "utf8");
    if (size === returnedBytes) break;
    returnedBytes = size;
  }
  return { text: JSON.stringify({ messages: kept, truncated: true, returnedBytes }), truncated: true };
}

/*
 * Same rule as truncateMessages, for any list under a named key: whole records
 * only, with the marker inside the payload the model reads.
 */
function truncateList(key: string, items: readonly unknown[], extra: Record<string, unknown>, maxBytes: number) {
  const build = (kept: readonly unknown[], truncated: boolean) =>
    JSON.stringify({ ...extra, [key]: kept, ...(truncated ? { truncated: true } : {}) });
  const full = build(items, false);
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return { text: full, truncated: false };
  const kept: unknown[] = [];
  for (const item of items) {
    if (Buffer.byteLength(build([...kept, item], true), "utf8") > maxBytes) break;
    kept.push(item);
  }
  return { text: build(kept, true), truncated: true };
}

/** A provider failure is never a 200 with an empty list: it is a labelled failure the model can act on. */
function readFailure(failure: GmailReadFailure): GatewayOutcome {
  if (failure.code === "not_configured") {
    return { ok: false, status: 503, code: "integration_not_configured", message: failure.message };
  }
  return { ok: false, status: 502, code: "provider_error", message: failure.message };
}

export function createGateway({ transport }: { transport: Transport }) {
  async function call(context: GatewayContext): Promise<GatewayOutcome> {
    const capability = PROVIDER_TOOLS[context.tool as keyof typeof PROVIDER_TOOLS];
    if (!capability) {
      // Unknown before any read of the database: a scanner learns only that the
      // name is not in the catalog.
      return { ok: false, status: 404, code: "not_found", message: "No such provider tool." };
    }
    const spec = CAPABILITIES[capability];

    const parsed = parseCall(context.tool, context.args);
    if (!parsed.ok) return invalidArguments(parsed.message);

    const grantId = grantIdFrom(context.run.policySnapshot);

    // 1. The frozen snapshot. For a granted run the decision below also carries
    // this ceiling, so the two gates cannot disagree.
    if (!toolAllowed(context.run.policySnapshot, capability)) {
      if (grantId) await recordGrantDecision(context, grantId, capability, parsed, parsed.accountAlias);
      return {
        ok: false,
        status: 403,
        code: "capability_not_allowed",
        message: `This run may not use ${capability}.`,
      };
    }

    // 2. Live account state, re-read per call: revocation and a tier flipped
    // in Connectors have to bite at once.
    const account = await resolveAccount(context, spec.provider, parsed.accountAlias);
    if (!account.ok) return account.outcome;

    // 2b. The connection's tier, read live with the account. The snapshot above
    // bounds what the run may want; the tier bounds what this connection grants.
    if (!tierAllows(spec.provider, account.accessTier, capability)) {
      return {
        ok: false,
        status: 403,
        code: "permission_denied",
        message: `Agent access for "${account.alias}" does not include this. Raise the tier in Connectors.`,
      };
    }

    // 2c. The account's own fine-grained switches, live with the tier: the
    // owner can turn one capability off for this connection without lowering
    // the tier, and that has to bite at once too.
    if (account.disabledCapabilities.includes(capability)) {
      return {
        ok: false,
        status: 403,
        code: "permission_denied",
        message: `"${account.alias}" has this switched off in Connectors.`,
      };
    }

    // 3. Reserve the budget before anything is fetched. The reservation is the
    // row the next concurrent caller counts, so the cap holds under a burst;
    // the grant gate runs first so a denied call spends nothing.
    // 4. The delegation grant, when the run carries one. A denial here is a
    // recorded verdict and no effect.
    if (grantId) {
      const decision = await recordGrantDecision(context, grantId, capability, parsed, account.alias);
      if (!decision.allowed) {
        return {
          ok: false,
          status: 403,
          code: "grant_denied",
          message: `The delegation grant does not authorize this call (${decision.reasons.join(", ")}).`,
        };
      }
    }

    // 5. Loop detection, before the budget: the third identical read in one run
    // is the run spinning, so it is parked for review instead of spending a
    // provider call to confirm what the first two already returned. Reads only:
    // a send files a proposal the owner decides on — its dedupe key absorbs
    // replays, and the redacted trace erases the body, so identical-looking
    // sends may be legitimate wording revisions. Same tool and same redacted
    // arguments is the identity; the redacted form is what the rows store, so
    // the comparison cannot miss what it already recorded.
    if (parsed.tool !== "gmail_send" && parsed.tool !== "writer_draft_reply") {
      const parked = await detectLoop(context, parsed);
      if (parked) {
        return {
          ok: false,
          status: 429,
          code: "loop_detected",
          message:
            "This run has made the same call repeatedly. It is parked for review; approve or retry it from the run's page.",
        };
      }
    }

    const reservation = await reserveCall(context, spec.provider, parsed, account.alias);
    if (!reservation.ok) return reservation.outcome;

    if (parsed.generic) {
      return read(context, parsed, account.alias, account.connectedAccountId, reservation);
    }
    if (parsed.tool === "gmail_send") return proposeSend(context, capability, parsed, account, reservation);
    if (parsed.tool === "writer_draft_reply") return proposeWriterDraft(context, parsed, account, reservation);
    return read(context, parsed, account.alias, account.connectedAccountId, reservation);
  }

  /**
   * Two prior calls with the same tool and arguments in this run, and the run
   * parks — settled or failed, a returned result is what the repetition is
   * made of; a pending reservation is not (it is in flight, and parking on it
   * would strand a call that may still succeed). Best-effort: a failed check
   * returns false and lets the limits handle the burst.
   */
  async function detectLoop(context: GatewayContext, parsed: ParsedCall & { ok: true }): Promise<boolean> {
    const args = JSON.stringify(redactArguments(parsed));
    try {
      const [row] = await db
        .select({ n: count() })
        .from(toolCalls)
        .where(
          and(
            eq(toolCalls.workspaceId, context.auth.workspaceId),
            eq(toolCalls.runId, context.run.id),
            eq(toolCalls.toolName, parsed.tool),
            sql`arguments is not distinct from ${args}::jsonb`,
            isNotNull(toolCalls.ok),
          ),
        );
      const prior = Number(row?.n ?? 0);
      if (prior < LOOP_CALL_THRESHOLD - 1) return false;
      await parkRunForReview({
        workspaceId: context.auth.workspaceId,
        runId: context.run.id,
        reason: `${parsed.tool} called with identical arguments ${prior + 1} times in one run.`,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function resolveAccount(
    context: GatewayContext,
    provider: string,
    alias: string | undefined,
  ): Promise<
    | {
        ok: true;
        alias: string;
        connectedAccountId: string;
        externalAccountId: string;
        displayName: string | null;
        accessTier: string;
        disabledCapabilities: string[];
      }
    | { ok: false; outcome: GatewayOutcome }
  > {
    const resolved = await resolveConnectedAccount(context.auth, provider, alias);
    if (resolved.ok) {
      // A project-scoped run only reaches the accounts the project allowlists.
      // No rows means unscoped - the workspace's own accounts, unchanged.
      const projectSubject = projectSubjectOf(context.run.subjects);
      if (projectSubject) {
        const allowlist = await projectAccountAllowlist(context.auth, projectSubject.id);
        if (allowlist !== null && !allowlist.includes(resolved.externalAccountId)) {
          return {
            ok: false,
            outcome: {
              ok: false,
              status: 403,
              code: "account_not_connected",
              message: `The ${provider} account "${resolved.alias}" is not enabled for the project this session belongs to. Enable it in the project's connectors.`,
            },
          };
        }
      }
      return resolved;
    }
    // permission_denied is no longer a resolution outcome: the tier gate owns
    // it, after the account resolves. Resolution fails only on not_connected
    // or ambiguity.
    const code = resolved.code === "ambiguous" ? "ambiguous_account" : "account_not_connected";
    return { ok: false, outcome: { ok: false, status: 403, code, message: resolved.message } };
  }

  async function read(
    context: GatewayContext,
    parsed: ParsedSearch | ParsedThread | ParsedOther | ParsedGeneric,
    accountAlias: string,
    connectedAccountId: string,
    reservation: { reservationId: string; startedAt: number },
  ): Promise<GatewayOutcome> {
    if (parsed.generic || (parsed.tool !== "gmail_search" && parsed.tool !== "gmail_read_thread")) {
      return readOther(parsed, connectedAccountId, reservation);
    }
    const result =
      parsed.tool === "gmail_search"
        ? await searchGmailMessages(transport, {
            connectedAccountId,
            query: parsed.args.query,
            limit: parsed.args.limit ?? LIMITS.defaultResults,
            accountAlias,
          })
        : await readGmailThread(transport, { connectedAccountId, threadId: parsed.args.threadId });

    if (!result.ok) {
      await settleCall(reservation.reservationId, {
        ok: false,
        errorCode: result.code,
        durationMs: Date.now() - reservation.startedAt,
      });
      return readFailure(result);
    }

    const { text, truncated } = truncateMessages(result.messages, LIMITS.maxResponseBytes);
    await settleCall(reservation.reservationId, {
      ok: true,
      result: { messages: result.messages.length, truncated },
      durationMs: Date.now() - reservation.startedAt,
    });
    return { ok: true, result: { content: [{ type: "text", text }] } };
  }

  async function readOther(
    parsed: ParsedOther | ParsedGeneric,
    connectedAccountId: string,
    reservation: { reservationId: string; startedAt: number },
  ): Promise<GatewayOutcome> {
    const limit = typeof parsed.args.limit === "number" ? parsed.args.limit : LIMITS.defaultResults;

    // Registry-driven reads need no bespoke function: the spec is the whole
    // provider slice (Tasks 8-11 add entries, never gateway code).
    const genericSpec = GENERIC_READS[parsed.tool];
    if (genericSpec) {
      const r = await genericList(transport, genericSpec, {
        connectedAccountId,
        query: typeof parsed.args.query === "string" ? parsed.args.query : undefined,
        limit,
      });
      if (!r.ok) {
        await settleCall(reservation.reservationId, {
          ok: false,
          errorCode: r.code,
          durationMs: Date.now() - reservation.startedAt,
        });
        return readFailure(r);
      }
      await settleCall(reservation.reservationId, {
        ok: true,
        result: { records: r.items.length, truncated: r.truncated },
        durationMs: Date.now() - reservation.startedAt,
      });
      const marker = r.truncated ? "\n[Truncated: the result was too large to show in full.]" : "";
      const text = r.items.length ? r.items.join("\n") + marker : "No results.";
      return { ok: true, result: { content: [{ type: "text", text }] } };
    }

    // The registry branch returned above for every generic tool, so only the
    // bespoke reads reach the switch.
    const other = parsed as ParsedOther;
    let outcome: { ok: true; text: string; truncated: boolean; count: number } | { ok: false; code: string; message: string };
    switch (other.tool) {
      case "github_search": {
        const r = await searchGithub(transport, { connectedAccountId, query: String(other.args.query), limit });
        outcome = r.ok ? { ok: true, ...truncateList("items", r.items, {}, LIMITS.maxResponseBytes), count: r.items.length } : r;
        break;
      }
      case "github_read_issue": {
        const r = await readGithubIssue(transport, {
          connectedAccountId,
          owner: String(other.args.owner),
          repo: String(other.args.repo),
          number: Number(other.args.number),
        });
        if (!r.ok) {
          outcome = r;
          break;
        }
        const { comments, ...issue } = r.item;
        outcome = { ok: true, ...truncateList("comments", comments, { issue }, LIMITS.maxResponseBytes), count: comments.length + 1 };
        break;
      }
      case "linear_search_issues": {
        const r = await searchLinearIssues(transport, { connectedAccountId, term: String(other.args.query), limit });
        outcome = r.ok ? { ok: true, ...truncateList("items", r.items, {}, LIMITS.maxResponseBytes), count: r.items.length } : r;
        break;
      }
      case "linear_read_issue": {
        const r = await readLinearIssue(transport, { connectedAccountId, identifier: String(other.args.identifier) });
        if (!r.ok) {
          outcome = r;
          break;
        }
        const { comments, ...issue } = r.item;
        outcome = { ok: true, ...truncateList("comments", comments, { issue }, LIMITS.maxResponseBytes), count: comments.length + 1 };
        break;
      }
      case "slack_list_channels": {
        const r = await listSlackChannels(transport, { connectedAccountId, limit });
        outcome = r.ok ? { ok: true, ...truncateList("channels", r.channels, {}, LIMITS.maxResponseBytes), count: r.channels.length } : r;
        break;
      }
      case "notion_search": {
        const r = await searchNotion(transport, { connectedAccountId, query: String(other.args.query), limit });
        outcome = r.ok ? { ok: true, ...truncateList("items", r.items, {}, LIMITS.maxResponseBytes), count: r.items.length } : r;
        break;
      }
      case "notion_read_page": {
        const r = await readNotionPage(transport, { connectedAccountId, pageId: String(other.args.pageId) });
        outcome = r.ok
          ? {
              ok: true,
              text: JSON.stringify({ page: r.item, markdown: r.markdown, ...(r.truncated ? { truncated: true } : {}) }),
              truncated: r.truncated,
              count: 1,
            }
          : r;
        break;
      }
      case "linkedin_get_profile": {
        const r = await getLinkedInProfile(transport, { connectedAccountId });
        outcome = r.ok
          ? { ok: true, text: JSON.stringify({ profile: r.profile }), truncated: false, count: 1 }
          : r;
        break;
      }
      case "instagram_get_profile": {
        const r = await getInstagramProfile(transport, { connectedAccountId });
        outcome = r.ok
          ? { ok: true, text: JSON.stringify({ profile: r.profile }), truncated: false, count: 1 }
          : r;
        break;
      }
      case "instagram_list_media": {
        const r = await listInstagramMedia(transport, { connectedAccountId, limit });
        outcome = r.ok ? { ok: true, ...truncateList("items", r.items, {}, LIMITS.maxResponseBytes), count: r.items.length } : r;
        break;
      }
      case "slack_read_channel": {
        const r = await readSlackChannel(transport, { connectedAccountId, channel: String(other.args.channel), limit });
        outcome = r.ok
          ? { ok: true, ...truncateList("messages", r.messages, { hasMore: r.hasMore }, LIMITS.maxResponseBytes), count: r.messages.length }
          : r;
        break;
      }
    }
    if (!outcome.ok) {
      await settleCall(reservation.reservationId, {
        ok: false,
        errorCode: outcome.code,
        durationMs: Date.now() - reservation.startedAt,
      });
      return readFailure(outcome);
    }
    await settleCall(reservation.reservationId, {
      ok: true,
      result: { records: outcome.count, truncated: outcome.truncated },
      durationMs: Date.now() - reservation.startedAt,
    });
    return { ok: true, result: { content: [{ type: "text", text: outcome.text }] } };
  }

  /*
   * The only write path a tool has. It writes a proposal and revision 1 in one
   * transaction and returns `awaiting_review`; there is no branch here that can
   * report a send. The revision is what makes the proposal decidable at all:
   * `decideProposal` binds an approval to the newest revision and refuses a
   * proposal that has none.
   */
  async function proposeSend(
    context: GatewayContext,
    capability: Capability,
    parsed: ParsedSend,
    account: { alias: string; externalAccountId: string; connectedAccountId: string; displayName: string | null },
    reservation: { reservationId: string; startedAt: number },
  ): Promise<GatewayOutcome> {
    const accountAlias = account.alias;
    const { to, subject, body, messageId } = parsed.args;
    const inReplyTo = messageId;
    const dedupeKey = `gmail.mcp:${context.auth.workspaceId}:${to}:${subject}:${inReplyTo ?? ""}`;

    const created = await withTransaction(async (tx) => {
      const proposal = await createProposal(
        tx,
        { workspaceId: context.auth.workspaceId },
        {
          capability,
          riskClass: "external_write",
          accountAlias,
          title: `Send email to ${to}`,
          expectedEffect: `Sends a message from ${accountAlias} to ${to} with subject "${subject}".`,
          dedupeKey,
          runId: context.run.id,
          // The replaced eve tool expired its proposals after a day; a send
          // intent older than that is stale intent, not a standing approval.
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        },
      );
      // A replayed intent resolves the proposal that already exists; appending a
      // revision would make the owner approve the same intent twice.
      if (!proposal.deduplicated) {
        /*
         * Pin the sender the gateway already resolved for this call, so the
         * review card shows the exact account BEFORE the decision and the
         * approval binds this revision unchanged. The executor re-resolves
         * and refuses when the identity no longer matches.
         */
        const pinned = withSenderAccountPin(
          {
            resolved: true,
            externalAccountId: account.externalAccountId,
            connectedAccountId: account.connectedAccountId,
            alias: account.alias,
            sender: account.displayName ?? account.alias,
          },
          { to, subject, body, inReplyTo, accountAlias },
          { to, subject, body },
        );
        await tx.insert(actionRevisions).values({
          workspaceId: context.auth.workspaceId,
          proposalId: proposal.proposalId,
          revisionNumber: 1,
          payload: pinned.payload,
          preview: pinned.preview,
          createdBy: context.auth.userId,
        });
        return { ...proposal, bodyChanged: false };
      }

      /*
       * The dedupe key is spec-mandated and is body-blind, so a second call with
       * different wording lands on the first proposal. Returning it as an
       * ordinary replay would discard the new text silently and let the owner
       * approve wording the agent never sent. The caller gets `bodyChanged` so
       * it can say so; the stored revision is left untouched, because rewriting
       * an intent a reviewer may already have open is worse than surfacing the
       * mismatch.
       */
      const [latest] = await tx
        .select({ payload: actionRevisions.payload })
        .from(actionRevisions)
        .where(eq(actionRevisions.proposalId, proposal.proposalId))
        .orderBy(desc(actionRevisions.revisionNumber))
        .limit(1);
      const stored = (latest?.payload as { body?: unknown } | null | undefined)?.body;
      return { ...proposal, bodyChanged: stored !== body };
    });

    await settleCall(reservation.reservationId, {
      ok: true,
      result: { proposalId: created.proposalId, deduplicated: created.deduplicated, bodyChanged: created.bodyChanged },
      durationMs: Date.now() - reservation.startedAt,
    });

    return {
      ok: true,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "awaiting_review",
              proposalId: created.proposalId,
              deduplicated: created.deduplicated,
              ...(created.bodyChanged ? { bodyChanged: true } : {}),
            }),
          },
        ],
      },
    };
  }

  /*
   * The Writer's draft path (ASH-281): the ONE proposal path that reads
   * through the transport first - reading the thread it will answer is the
   * draft's grounding. The transport's closed read-only surface keeps the
   * structural rule intact: no proposal path can WRITE through it.
   */
  async function proposeWriterDraft(
    context: GatewayContext,
    parsed: ParsedWriterDraft,
    account: ResolvedSenderAccount,
    reservation: { reservationId: string; startedAt: number },
  ): Promise<GatewayOutcome> {
    try {
      const outcome = await draftReply(
        context.auth,
        { runId: context.run.id, threadId: parsed.args.threadId, instruction: parsed.args.instruction },
        { transport, account },
      );
      await settleCall(reservation.reservationId, {
        ok: true,
        result: { proposalId: outcome.proposalId, revised: outcome.revised, fresh: outcome.fresh },
        durationMs: Date.now() - reservation.startedAt,
      });
      return {
        ok: true,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "awaiting_review",
                proposalId: outcome.proposalId,
                to: outcome.to,
                subject: outcome.subject,
                citations: outcome.citations.length,
                flags: outcome.flags,
                ...(outcome.revised ? { revised: true } : {}),
                ...(outcome.fresh ? { freshProposal: true } : {}),
              }),
            },
          ],
        },
      };
    } catch (cause) {
      const code = cause instanceof WriterDraftError ? cause.code : "writer_failed";
      const message = cause instanceof Error ? cause.message : "The draft could not be written.";
      await settleCall(reservation.reservationId, {
        ok: false,
        errorCode: code,
        durationMs: Date.now() - reservation.startedAt,
      });
      const status = code === "writer_unconfigured" ? 503 : code === "thread_read_failed" ? 502 : 422;
      return { ok: false, status, code, message };
    }
  }

  return { call };
}
