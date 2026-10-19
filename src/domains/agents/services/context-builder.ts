import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { artifactVersions, artifacts, claimEvidence, claims, sources } from "@/domains/knowledge/schema";
import {
  contextManifestItems,
  contextManifests,
  memoryItems,
  memoryRevisions,
  messages,
  threads,
} from "../schema";
import { agentProfileRevisions } from "../runtime-schema";

/*
 * ASH-118 (RT04): source-version-pinned context assembly.
 *
 * The rules this module enforces, in one place:
 *   - everything loads workspace-scoped; an id from another workspace and a
 *     missing id produce the same recorded gap, never leaked content;
 *   - only ACCEPTED memory enters context — proposed, rejected or retired
 *     memory is a recorded gap, not silently treated as a preference;
 *   - a pinned artifact version that is no longer current is marked
 *     `superseded`, never presented as current truth;
 *   - conversation is `message` items, evidence is `source_span` items, and
 *     the two are never mixed: an assistant message is not a source;
 *   - the budget truncates by exclusion with a reason, not by silently
 *     dropping rows;
 *   - loading an existing manifest re-checks access (live revocation): what
 *     became inaccessible since construction is reported as a gap.
 */

/** ~4 chars per token: an estimate for budgeting, never billing. */
export const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));
const contentHash = (text: string) => createHash("sha256").update(text).digest("hex");

export type ContextItemInput = {
  kind: "record" | "artifact_version" | "source_span" | "memory_revision" | "message";
  refId: string;
  refParentId?: string | null;
  refVersion?: number | null;
  text: string;
  staleness?: "current" | "superseded" | "stale" | "conflicting";
  selectionReason: string;
};

export type ContextGap = { kind: string; refId: string; reason: string };

export type BuiltContext = {
  manifestId: string;
  items: (ContextItemInput & { staleness: string })[];
  gaps: ContextGap[];
  usedTokens: number;
  truncated: boolean;
};

export type ContextBuildInput = {
  workspaceId: string;
  purpose: string;
  runId?: string | null;
  profileRevisionId?: string | null;
  createdBy?: string | null;
  /** Pinned artifact versions to include (marked superseded when no longer current). */
  artifactVersionIds?: string[];
  /** Claims whose accepted evidence spans should be assembled. */
  claimIds?: string[];
  /** Memory items the caller believes apply; only accepted ones enter context. */
  memoryItemIds?: string[];
  /** Bounded conversation history: the thread's most recent messages. */
  threadId?: string;
  maxMessages?: number;
  maxTokens?: number;
  selectionPolicy?: Record<string, unknown>;
};

const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_MAX_MESSAGES = 40;

/**
 * Builds a context manifest and its items from authorized, version-pinned
 * inputs. Returns the assembled payload plus the persisted manifest id; the
 * database rows are the inspectable record of the same thing.
 */
export async function buildContext(input: ContextBuildInput): Promise<BuiltContext> {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxMessages = input.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const items: ContextItemInput[] = [];
  const gaps: ContextGap[] = [];
  const ws = input.workspaceId;

  if (input.artifactVersionIds?.length) {
    const rows = await db
      .select({
        versionId: artifactVersions.id,
        versionNumber: artifactVersions.versionNumber,
        plainText: artifactVersions.plainText,
        artifactId: artifacts.id,
        currentVersionId: artifacts.currentVersionId,
        archivedAt: artifacts.archivedAt,
        title: artifacts.title,
      })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifactVersions.artifactId, artifacts.id))
      .where(and(inArray(artifactVersions.id, input.artifactVersionIds), eq(artifactVersions.workspaceId, ws)));
    const found = new Map(rows.map((r) => [r.versionId, r]));
    for (const id of input.artifactVersionIds) {
      const row = found.get(id);
      if (!row) {
        gaps.push({ kind: "artifact_version", refId: id, reason: "not found in workspace" });
        continue;
      }
      if (row.archivedAt) {
        gaps.push({ kind: "artifact_version", refId: id, reason: "artifact archived" });
        continue;
      }
      const superseded = row.currentVersionId !== row.versionId;
      items.push({
        kind: "artifact_version",
        refId: id,
        refParentId: row.artifactId,
        refVersion: row.versionNumber,
        text: row.plainText ?? "",
        staleness: superseded ? "superseded" : "current",
        selectionReason: superseded
          ? `pinned version ${row.versionNumber} of "${row.title}" (a newer version exists)`
          : `current version ${row.versionNumber} of "${row.title}"`,
      });
    }
  }

  if (input.claimIds?.length) {
    const rows = await db
      .select({
        claimId: claims.id,
        statement: claims.statement,
        claimStatus: claims.status,
        evidenceId: claimEvidence.id,
        sourceId: sources.id,
        quote: claimEvidence.quote,
        startOffset: claimEvidence.startOffset,
        endOffset: claimEvidence.endOffset,
        sourceUrl: sources.url,
        sourceHash: sources.contentHash,
      })
      .from(claims)
      .leftJoin(claimEvidence, eq(claimEvidence.claimId, claims.id))
      .leftJoin(sources, eq(claimEvidence.sourceId, sources.id))
      .where(and(inArray(claims.id, input.claimIds), eq(claims.workspaceId, ws)));
    const byClaim = new Map<string, typeof rows>();
    for (const row of rows) byClaim.set(row.claimId, [...(byClaim.get(row.claimId) ?? []), row]);
    for (const claimId of input.claimIds) {
      const claimRows = byClaim.get(claimId);
      if (!claimRows?.length) {
        gaps.push({ kind: "source_span", refId: claimId, reason: "claim not found in workspace" });
        continue;
      }
      const withSource = claimRows.filter((r) => r.sourceId);
      if (!withSource.length) {
        // Missing evidence is an explicit gap, not an invented citation.
        gaps.push({ kind: "source_span", refId: claimId, reason: "claim has no accessible source evidence" });
        continue;
      }
      for (const r of withSource) {
        items.push({
          kind: "source_span",
          refId: r.sourceId!,
          refParentId: claimId,
          text: r.quote ?? "",
          contentHash: r.sourceHash ?? undefined,
          selectionReason: `evidence for claim: ${r.statement.slice(0, 120)}`,
        } as ContextItemInput & { contentHash?: string });
      }
    }
  }

  if (input.memoryItemIds?.length) {
    const rows = await db
      .select({
        itemId: memoryItems.id,
        status: memoryItems.status,
        revisionId: memoryRevisions.id,
        body: memoryRevisions.body,
        revisionCreatedAt: memoryRevisions.createdAt,
      })
      .from(memoryItems)
      .leftJoin(memoryRevisions, eq(memoryRevisions.memoryItemId, memoryItems.id))
      .where(and(inArray(memoryItems.id, input.memoryItemIds), eq(memoryItems.workspaceId, ws)))
      .orderBy(desc(memoryRevisions.createdAt));
    const byItem = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!byItem.has(row.itemId)) byItem.set(row.itemId, []);
      byItem.get(row.itemId)!.push(row);
    }
    for (const itemId of input.memoryItemIds) {
      const itemRows = byItem.get(itemId);
      if (!itemRows?.length) {
        gaps.push({ kind: "memory_revision", refId: itemId, reason: "memory not found in workspace" });
        continue;
      }
      const status = itemRows[0].status;
      if (status !== "accepted") {
        // Proposed, rejected or retired memory is not a fact or a preference.
        gaps.push({ kind: "memory_revision", refId: itemId, reason: `memory is ${status}, not accepted` });
        continue;
      }
      const latest = itemRows.find((r) => r.revisionId);
      if (!latest) continue;
      items.push({
        kind: "memory_revision",
        refId: latest.revisionId!,
        refParentId: itemId,
        text: latest.body ?? "",
        selectionReason: "accepted memory, latest revision",
      });
    }
  }

  if (input.threadId) {
    const [thread] = await db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, input.threadId), eq(threads.workspaceId, ws)))
      .limit(1);
    if (!thread) {
      gaps.push({ kind: "message", refId: input.threadId, reason: "thread not found in workspace" });
    } else {
      const rows = await db
        .select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.threadId, input.threadId), eq(messages.workspaceId, ws)))
        .orderBy(desc(messages.createdAt))
        .limit(maxMessages);
      for (const row of rows.reverse()) {
        items.push({
          kind: "message",
          refId: row.id,
          refParentId: input.threadId,
          text: row.content ?? "",
          // Conversation is context, never evidence: the kind says so.
          selectionReason: `conversation history (${row.role})`,
        });
      }
    }
  }

  // Budget by exclusion with reasons: priority order is records/evidence,
  // then memory, then conversation.
  const rank = (k: ContextItemInput["kind"]) =>
    ({ record: 0, artifact_version: 1, source_span: 2, memory_revision: 3, message: 4 })[k];
  const ordered = [...items].sort((a, b) => rank(a.kind) - rank(b.kind));
  let used = 0;
  let truncated = false;
  const finalItems: typeof items = [];
  for (const item of ordered) {
    const tokens = estimateTokens(item.text);
    if (used + tokens > maxTokens) {
      truncated = true;
      gaps.push({ kind: item.kind, refId: item.refId, reason: "excluded by context budget" });
      continue;
    }
    used += tokens;
    finalItems.push(item);
  }

  const [manifest] = await db
    .insert(contextManifests)
    .values({
      workspaceId: ws,
      runId: input.runId ?? null,
      profileRevisionId: input.profileRevisionId ?? null,
      purpose: input.purpose,
      selectionPolicy: input.selectionPolicy ?? {},
      retrievalScope: {
        artifactVersionIds: input.artifactVersionIds ?? [],
        claimIds: input.claimIds ?? [],
        memoryItemIds: input.memoryItemIds ?? [],
        threadId: input.threadId ?? null,
        maxMessages,
      },
      budget: { maxTokens, usedTokens: used, truncated },
      itemCount: finalItems.length,
      gapCount: gaps.length,
      createdBy: input.createdBy ?? null,
    })
    .returning({ id: contextManifests.id });

  let ordinal = 0;
  const gapOrdinalStart = finalItems.length;
  await db.insert(contextManifestItems).values([
    ...finalItems.map((item) => ({
      workspaceId: ws,
      manifestId: manifest.id,
      ordinal: ordinal++,
      kind: item.kind,
      refId: item.refId,
      refParentId: item.refParentId ?? null,
      refVersion: item.refVersion ?? null,
      contentHash: contentHash(item.text),
      tokenEstimate: estimateTokens(item.text),
      selectionReason: item.selectionReason,
      staleness: item.staleness ?? "current",
      included: true,
    })),
    ...gaps.map((gap, i) => ({
      workspaceId: ws,
      manifestId: manifest.id,
      ordinal: gapOrdinalStart + i,
      // Gaps keep the requested kind so the record shows what was asked for.
      kind: gap.kind as (typeof finalItems)[number]["kind"],
      refId: gap.refId,
      refParentId: null,
      refVersion: null,
      contentHash: null,
      tokenEstimate: 0,
      selectionReason: gap.reason,
      staleness: "stale" as const,
      included: false,
    })),
  ]);

  return {
    manifestId: manifest.id,
    items: finalItems.map((i) => ({ ...i, staleness: i.staleness ?? "current" })),
    gaps,
    usedTokens: used,
    truncated,
  };
}

/*
 * Re-reads a manifest with live access checks: anything revoked since
 * construction (archived artifact, retired memory, deleted thread) is
 * reported as a gap instead of being loaded. Historical items are preserved
 * in the table untouched — the manifest stays the record of what was used.
 */
export async function loadManifest(
  manifestId: string,
  workspaceId: string,
): Promise<{ items: ContextItemInput[]; gaps: ContextGap[] } | null> {
  const [manifest] = await db
    .select({ id: contextManifests.id })
    .from(contextManifests)
    .where(and(eq(contextManifests.id, manifestId), eq(contextManifests.workspaceId, workspaceId)))
    .limit(1);
  if (!manifest) return null;
  const rows = await db
    .select()
    .from(contextManifestItems)
    .where(and(eq(contextManifestItems.manifestId, manifestId), eq(contextManifestItems.included, true)))
    .orderBy(asc(contextManifestItems.ordinal));

  const items: ContextItemInput[] = [];
  const gaps: ContextGap[] = [];
  for (const row of rows) {
    if (row.kind === "artifact_version") {
      const [v] = await db
        .select({ plainText: artifactVersions.plainText, archivedAt: artifacts.archivedAt })
        .from(artifactVersions)
        .innerJoin(artifacts, eq(artifactVersions.artifactId, artifacts.id))
        .where(and(eq(artifactVersions.id, row.refId), eq(artifactVersions.workspaceId, workspaceId)))
        .limit(1);
      if (!v || v.archivedAt) {
        gaps.push({ kind: row.kind, refId: row.refId, reason: "revoked since manifest construction" });
        continue;
      }
      items.push({ kind: row.kind, refId: row.refId, refParentId: row.refParentId, refVersion: row.refVersion, text: v.plainText ?? "", staleness: row.staleness, selectionReason: row.selectionReason ?? "" });
    } else if (row.kind === "memory_revision") {
      const [r] = await db
        .select({ body: memoryRevisions.body, status: memoryItems.status })
        .from(memoryRevisions)
        .innerJoin(memoryItems, eq(memoryRevisions.memoryItemId, memoryItems.id))
        .where(and(eq(memoryRevisions.id, row.refId), eq(memoryRevisions.workspaceId, workspaceId)))
        .limit(1);
      if (!r || r.status !== "accepted") {
        gaps.push({ kind: row.kind, refId: row.refId, reason: "memory no longer accepted" });
        continue;
      }
      items.push({ kind: row.kind, refId: row.refId, refParentId: row.refParentId, refVersion: row.refVersion, text: r.body, staleness: row.staleness, selectionReason: row.selectionReason ?? "" });
    } else if (row.kind === "message") {
      const [m] = await db
        .select({ content: messages.content })
        .from(messages)
        .where(and(eq(messages.id, row.refId), eq(messages.workspaceId, workspaceId)))
        .limit(1);
      if (!m) {
        gaps.push({ kind: row.kind, refId: row.refId, reason: "message no longer available" });
        continue;
      }
      items.push({ kind: row.kind, refId: row.refId, refParentId: row.refParentId, refVersion: row.refVersion, text: m.content ?? "", staleness: row.staleness, selectionReason: row.selectionReason ?? "" });
    } else if (row.kind === "source_span") {
      const [src] = await db
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.id, row.refId), eq(sources.workspaceId, workspaceId)))
        .limit(1);
      if (!src) {
        // Deleted evidence is reported honestly, not silently survived.
        gaps.push({ kind: row.kind, refId: row.refId, reason: "source no longer available" });
        continue;
      }
      items.push({ kind: row.kind, refId: row.refId, refParentId: row.refParentId, refVersion: row.refVersion, text: "", staleness: row.staleness, selectionReason: row.selectionReason ?? "" });
    }
  }
  return { items, gaps };
}

export type ClaimSupport = {
  claimId: string;
  statement: string;
  /** Source-backed assertions are distinguished from unsupported inference. */
  supported: boolean;
  spans: { sourceId: string; quote: string | null; malformed: boolean }[];
  reason?: string;
};

/*
 * Validates generated evidence references against accessible source
 * versions/spans. A claim with no accessible span is unsupported — grading
 * actual support, not citation presence. A span with impossible offsets is
 * malformed, which is reported rather than counted as support.
 */
export async function validateClaimEvidence(
  claimIds: string[],
  workspaceId: string,
): Promise<ClaimSupport[]> {
  if (!claimIds.length) return [];
  const rows = await db
    .select({
      claimId: claims.id,
      statement: claims.statement,
      evidenceId: claimEvidence.id,
      sourceId: claimEvidence.sourceId,
      quote: claimEvidence.quote,
      startOffset: claimEvidence.startOffset,
      endOffset: claimEvidence.endOffset,
      sourceAccessible: sources.id,
    })
    .from(claims)
    .leftJoin(claimEvidence, eq(claimEvidence.claimId, claims.id))
    .leftJoin(sources, and(eq(claimEvidence.sourceId, sources.id), eq(sources.workspaceId, workspaceId)))
    .where(and(inArray(claims.id, claimIds), eq(claims.workspaceId, workspaceId)));
  const byClaim = new Map<string, ClaimSupport>();
  for (const row of rows) {
    const support = byClaim.get(row.claimId) ?? { claimId: row.claimId, statement: row.statement, supported: false, spans: [] };
    if (row.evidenceId && row.sourceAccessible) {
      const malformed =
        (row.startOffset != null && row.startOffset < 0) ||
        (row.endOffset != null && row.startOffset != null && row.endOffset < row.startOffset);
      support.spans.push({ sourceId: row.sourceId!, quote: row.quote, malformed });
      if (!malformed) support.supported = true;
    }
    byClaim.set(row.claimId, support);
  }
  for (const id of claimIds) {
    if (!byClaim.has(id)) byClaim.set(id, { claimId: id, statement: "", supported: false, spans: [], reason: "claim not found in workspace" });
    const support = byClaim.get(id)!;
    if (!support.supported && !support.reason) {
      support.reason = support.spans.length ? "all evidence spans are malformed" : "no accessible source evidence";
    }
  }
  return claimIds.map((id) => byClaim.get(id)!);
}

/** The profile revision a manifest was built against, for audit readers. */
export async function getManifestProfileRevision(manifestId: string, workspaceId: string) {
  const [row] = await db
    .select({
      revisionId: agentProfileRevisions.id,
      revisionNumber: agentProfileRevisions.revision,
      contentHash: agentProfileRevisions.contentHash,
    })
    .from(contextManifests)
    .innerJoin(agentProfileRevisions, eq(contextManifests.profileRevisionId, agentProfileRevisions.id))
    .where(and(eq(contextManifests.id, manifestId), eq(contextManifests.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}
