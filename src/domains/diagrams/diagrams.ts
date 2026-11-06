import { and, eq, sql } from "drizzle-orm";
import type { ExcalidrawScenePayload } from "./types";
import { MAX_TOOL_PAYLOAD } from "@/domains/agents/stream-contract";
import { artifacts, artifactVersions, canvases, canvasVersions } from "@/domains/knowledge/schema";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";

/*
 * Diagrams: Mermaid is the stored source of truth, Excalidraw is the editor
 * (spec art_Yi8Fwsqn, locked decision 1). This module owns the two seams the
 * eve diagram tool needs:
 *
 *  1. `guardMermaidSource` — the structural guard. Everything the LLM authored
 *     passes through here before anything reaches the UI or the database:
 *     markdown fence stripping, hallucination-artifact rejection (unclosed
 *     fences, `````, YAML front-matter), the 20k char cap, label caps, and the
 *     ≤60-node sanity check. Its errors are written to be read by the model —
 *     they are what the one-shot self-correction pass sees.
 *  2. `persistDiagram` — create-or-refine in one append-only transaction.
 *     First generation creates the diagram artifact + v1 rows and the canvas +
 *     v1 scene; refinement appends a version to both chains and moves the
 *     artifact pointer. Nothing is ever mutated in place.
 */

export const DIAGRAM_CREATE_CAPABILITY = "diagram.create";

/** The Mermaid diagram types the tool accepts (spec §1). */
export const DIAGRAM_TYPES = ["flowchart", "sequence", "class", "state", "er", "journey", "gantt", "mindmap"] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

const MAX_MERMAID_CHARS = 20_000;
const MAX_NODES = 60;
const MAX_LABEL_CHARS = 200;

/** A refused diagram source. The message is agent-visible: it drives self-correction. */
export class DiagramError extends Error {}

export type GuardedMermaid = { ok: true; mermaid: string } | { ok: false; error: string };

/**
 * Strip a markdown code fence the model wrapped around its Mermaid, then run
 * the structural checks. Pure: same input, same verdict — unit-tested in
 * tests/unit/diagram-guard.test.ts.
 */
export function guardMermaidSource(raw: string): GuardedMermaid {
  const stripped = stripMermaidFences(raw.trim());
  if (!stripped.ok) return stripped;
  const mermaid = stripped.mermaid.trim();
  if (!mermaid) {
    return { ok: false, error: "the mermaid argument is empty after fence stripping — send the bare Mermaid source" };
  }
  if (mermaid.length > MAX_MERMAID_CHARS) {
    return {
      ok: false,
      error: `mermaid source is ${mermaid.length} characters; the cap is ${MAX_MERMAID_CHARS}. Draw a smaller diagram or split it into several.`,
    };
  }
  // YAML front-matter (a `---` line first) is a hallucination artifact — the
  // model pasted a document preamble. A flowchart's bare `a --- b` link never
  // puts `---` alone on the first line, so this cannot reject valid source.
  const firstLine = mermaid.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine === "---") {
    return {
      ok: false,
      error: "mermaid source starts with YAML front-matter (---). Send only diagram source, no document preamble.",
    };
  }
  const tooLongLabel = longestLabel(mermaid);
  if (tooLongLabel > MAX_LABEL_CHARS) {
    return {
      ok: false,
      error: `a node/edge label is ${tooLongLabel} characters; the cap is ${MAX_LABEL_CHARS}. Shorten the label — put detail in the chat reply instead.`,
    };
  }
  const nodes = countMermaidNodes(mermaid);
  if (nodes > MAX_NODES) {
    return {
      ok: false,
      error: `the diagram has about ${nodes} nodes; the cap is ${MAX_NODES}. Beyond that the render is unreadable — split it into smaller diagrams or drop detail.`,
    };
  }
  return { ok: true, mermaid };
}

/**
 * Remove one markdown fence wrapping the source. Zero fences → unchanged.
 * One opened-but-never-closed fence, text outside the fence, or more than one
 * fence are all refusals, not stripping jobs: they mean the model emitted
 * markdown, and guessing intent here would launder a hallucination into a
 * "valid" diagram.
 */
function stripMermaidFences(source: string): GuardedMermaid {
  const lines = source.split("\n");
  const fenceLines = lines.reduce<number[]>((acc, line, i) => {
    if (/^`{3,}/.test(line.trim())) acc.push(i);
    return acc;
  }, []);
  if (fenceLines.length === 0) return { ok: true, mermaid: source };
  const open = fenceLines[0];
  if (lines.slice(0, open).some((line) => line.trim() !== "")) {
    return {
      ok: false,
      error:
        "mermaid source has text before the opening code fence. Send the bare Mermaid source — no markdown, no commentary.",
    };
  }
  if (fenceLines.length < 2) {
    return {
      ok: false,
      error:
        "unclosed code fence: the mermaid argument opened ``` but never closed it. Send the bare Mermaid source without any markdown fencing.",
    };
  }
  if (fenceLines.length > 2) {
    return {
      ok: false,
      error: "mermaid source contains more than one code fence — send exactly one diagram, unwrapped.",
    };
  }
  const close = fenceLines[1];
  if (lines.slice(close + 1).some((line) => line.trim() !== "")) {
    return { ok: false, error: "mermaid source has text after the closing code fence — send only the diagram." };
  }
  return { ok: true, mermaid: lines.slice(open + 1, close).join("\n") };
}

/*
 * Node counting is a documented heuristic, not a parser: the guard's job is to
 * stop unreadable monsters, and it may err slightly over (an occasional extra
 * counted token only matters near the 60 cap, where rejection is the desired
 * behavior anyway). It must not wildly under-count, which is why labels are
 * stripped rather than treated as nodes.
 */
const NODE_STOPWORDS = new Set([
  // shared / flowchart
  "graph",
  "flowchart",
  "flowchart-v1",
  "flowchart-v2",
  "subgraph",
  "end",
  "direction",
  "lr",
  "rl",
  "tb",
  "bt",
  "td",
  // sequence
  "sequencediagram",
  "participant",
  "actor",
  "autonumber",
  "activate",
  "deactivate",
  "note",
  "over",
  "left",
  "right",
  "loop",
  "alt",
  "else",
  "par",
  "opt",
  "and",
  "critical",
  "option",
  "break",
  "rect",
  "box",
  // class / state
  "classdiagram",
  "classdef",
  "class",
  "statediagram",
  "statediagram-v2",
  "state",
  // er
  "erdiagram",
  "string",
  "int",
  "integer",
  "bigint",
  "float",
  "boolean",
  "bool",
  "date",
  "datetime",
  "timestamp",
  "uuid",
  "json",
  "jsonb",
  "varchar",
  "decimal",
  "numeric",
  "text",
  "o",
  "x",
  // journey / gantt / mindmap / pie
  "journey",
  "gantt",
  "pie",
  "mindmap",
  "root",
  "title",
  "section",
  "accdescription",
  "dateformat",
  "axisformat",
  "tickinterval",
  "today",
  "taskname",
  "excludes",
  "caption",
  // interaction / styling keywords that reference nodes without being them
  "as",
  "href",
  "callback",
  "yes",
  "no",
  "done",
  "active",
  "crit",
  "after",
  "varies",
  "hidden",
  "visible",
]);

/** Style/interaction statements: they reference nodes but are never node definitions. */
const NON_STATEMENT_LINE = /^\s*(classDef|class|linkStyle|style|click|call|subgraph|direction)\b/;

/** The longest label (node-shape content or pipe edge label) in the source. */
function longestLabel(mermaid: string): number {
  let longest = 0;
  const labelShapes =
    /\[\[([^\]\n]*)\]\]|\[([^\]\n]*)\]|\(\(([^)\n]*)\)\)|\(([^)\n]*)\)|\{([^}\n]*)\}|>([^\]\n<]*)\]|\|([^|\n]*)\|/g;
  for (const match of mermaid.matchAll(labelShapes)) {
    for (const group of match.slice(1)) {
      if (group !== undefined) longest = Math.max(longest, group.trim().length);
    }
  }
  return longest;
}

/** Count distinct node ids the heuristic finds. Pure. */
export function countMermaidNodes(mermaid: string): number {
  return mermaidNodeIds(mermaid).size;
}

function mermaidNodeIds(mermaid: string): Set<string> {
  const ids = new Set<string>();
  let text = mermaid
    .split("\n")
    .filter((line) => !line.trim().startsWith("%%"))
    .map((line) => line.replace(/%%.*$/, ""))
    .filter((line) => !NON_STATEMENT_LINE.test(line))
    .join("\n");

  // Shaped definitions first: id[label], id(label), id{label}, id((label)),
  // id[[label]], id>label]. Collected, then removed, so label prose and label
  // colons can never surface as node tokens.
  const shaped =
    /\b([A-Za-z0-9][A-Za-z0-9_-]*)\s*(\[\[[^\]\n]*\]\]|\[[^\]\n]*\]|\(\([^)\n]*\)\)|\([^)\n]*\)|\{[^}\n]*\}|>[^\]\n<]*\])/g;
  for (const match of text.matchAll(shaped)) ids.add(match[1]);
  text = text.replace(shaped, " ");

  text = text
    // pipe-delimited edge labels: a -->|not a node| b
    .replace(/\|[^|\n]*\|/g, " ")
    // labeled edge forms: a -- text --> b, a -. text .-> b, a == text ==> b
    .replace(/\s--\s[^;\n]*?\s*-{2,3}>/g, " -->")
    .replace(/\s-\.\s[^;\n]*?\s*\.->/g, " -.->")
    .replace(/\s==\s[^;\n]*?\s*={2,3}>/g, " ==>")
    // sequence-alias form: `participant U as User` names one node, U.
    .replace(/\bas\s+\S+/g, " ")
    // sequence message tails and erDiagram relationship/attribute labels run
    // from the first colon to end of line: `A->>B: prose` adds no node.
    .replace(/:[^|\n]*/g, " ");

  // What remains is ids and diagram keywords around the edge operators. Ids may
  // contain dashes ("my-node"), but the dashes in the arrow operators glue to
  // the tokens they touch ("U->>api" -> "U-"), which would make every
  // message-ordering variant a distinct node — trim those edges off.
  for (const token of text.split(/[^A-Za-z0-9_-]+/)) {
    const id = token.replace(/^-+|-+$/g, "");
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) && !NODE_STOPWORDS.has(id.toLowerCase())) ids.add(id);
  }
  return ids;
}

/*
 * Persistence. The version number each chain gets is max(existing)+1 computed
 * inside the transaction; the unique indexes on (artifactId, versionNumber)
 * and (canvasId, versionNumber) turn a concurrent double-append into a clean
 * rollback rather than a duplicate. The scene column holds a mermaid envelope
 * at generation time — the browser converts to Excalidraw lazily (locked
 * decision 4), and a save from the canvas editor appends later versions with
 * the full serialized scene.
 */

/** The persistence surface only needs identity, not the full AuthContext. */
export type DiagramAuth = { userId: string; workspaceId: string };

export type PersistDiagramInput = {
  title: string;
  /** Guarded source — callers must have run guardMermaidSource first. */
  mermaid: string;
  diagramType: DiagramType;
  /** The agent run asking for this persist; becomes producedByRunId on create. */
  runId: string | null;
  /** Present ⇒ refinement of that canvas instead of a new one. */
  canvasId?: string;
};

export type PersistDiagramResult = {
  canvasId: string;
  artifactId: string;
  /** The new artifact version number (v1 on create). */
  version: number;
};

export async function persistDiagram(auth: DiagramAuth, input: PersistDiagramInput): Promise<PersistDiagramResult> {
  return input.canvasId ? refineDiagram(auth, { ...input, canvasId: input.canvasId }) : createDiagram(auth, input);
}

function diagramVersionContent(input: PersistDiagramInput) {
  return { type: "diagram", mermaid: input.mermaid, diagramType: input.diagramType } as const;
}

function sceneEnvelope(input: PersistDiagramInput) {
  return { format: "mermaid", mermaid: input.mermaid, diagramType: input.diagramType } as const;
}

async function createDiagram(auth: DiagramAuth, input: PersistDiagramInput): Promise<PersistDiagramResult> {
  return withTransaction(async (tx) => {
    const [artifact] = await tx
      .insert(artifacts)
      .values({
        workspaceId: auth.workspaceId,
        kind: "diagram",
        title: input.title,
        status: "generated",
        producedByRunId: input.runId,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: artifacts.id });
    const [version] = await tx
      .insert(artifactVersions)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: artifact.id,
        versionNumber: 1,
        content: diagramVersionContent(input),
        // The Mermaid source is the plain-text projection: full-text search
        // finds diagrams by what they draw about.
        plainText: input.mermaid,
        reason: "generated",
        createdBy: auth.userId,
      })
      .returning({ id: artifactVersions.id });
    await tx.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
    const [canvas] = await tx
      .insert(canvases)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: artifact.id,
        title: input.title,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: canvases.id });
    await tx.insert(canvasVersions).values({
      workspaceId: auth.workspaceId,
      canvasId: canvas.id,
      versionNumber: 1,
      scene: sceneEnvelope(input),
      createdBy: auth.userId,
    });
    return { canvasId: canvas.id, artifactId: artifact.id, version: 1 };
  });
}

async function refineDiagram(
  auth: DiagramAuth,
  input: PersistDiagramInput & { canvasId: string },
): Promise<PersistDiagramResult> {
  return withTransaction(async (tx) => {
    // Workspace is part of every lookup: a cross-workspace canvasId is the
    // same "not found" as a bogus one — no existence leak across tenants.
    const [canvas] = await tx
      .select({ id: canvases.id, artifactId: canvases.artifactId })
      .from(canvases)
      .where(and(eq(canvases.id, input.canvasId), eq(canvases.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!canvas) throw new DiagramError("no canvas with this id in this workspace");
    const [artifact] = await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.id, canvas.artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!artifact) throw new DiagramError("the canvas's diagram artifact is missing");

    const nextArtifactVersion = await nextArtifactVersionNumber(tx, artifact.id);
    const nextCanvasVersion = await nextCanvasVersionNumber(tx, canvas.id);

    const [version] = await tx
      .insert(artifactVersions)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: artifact.id,
        versionNumber: nextArtifactVersion,
        content: diagramVersionContent(input),
        plainText: input.mermaid,
        reason: "generated",
        // The artifact row keeps the creating run in producedByRunId; the
        // refining run's provenance lives on the version it produced.
        note: input.runId ? `refined by diagram run ${input.runId}` : null,
        createdBy: auth.userId,
      })
      .returning({ id: artifactVersions.id });
    await tx
      .update(artifacts)
      .set({ currentVersionId: version.id, title: input.title, updatedBy: auth.userId })
      .where(eq(artifacts.id, artifact.id));
    await tx.insert(canvasVersions).values({
      workspaceId: auth.workspaceId,
      canvasId: canvas.id,
      versionNumber: nextCanvasVersion,
      scene: sceneEnvelope(input),
      createdBy: auth.userId,
    });
    await tx.update(canvases).set({ title: input.title, updatedBy: auth.userId }).where(eq(canvases.id, canvas.id));
    return { canvasId: canvas.id, artifactId: artifact.id, version: nextArtifactVersion };
  });
}

async function nextArtifactVersionNumber(tx: TxDrizzle, artifactId: string): Promise<number> {
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(${artifactVersions.versionNumber}), 0) + 1` })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId));
  return row?.next ?? 1;
}

async function nextCanvasVersionNumber(tx: TxDrizzle, canvasId: string): Promise<number> {
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(${canvasVersions.versionNumber}), 0) + 1` })
    .from(canvasVersions)
    .where(eq(canvasVersions.canvasId, canvasId));
  return row?.next ?? 1;
}

/**
 * A save from the canvas editor: one more row on the canvas's append-only
 * version chain holding the serialized Excalidraw drawing, and the canvas
 * title when the editor renamed it. Same invariants as refineDiagram — the
 * next version number is computed inside the transaction, the
 * (canvasId, versionNumber) unique index turns a concurrent double-save
 * into a clean rollback, and the workspace lookup makes a foreign canvasId
 * the same "not found" as a bogus one. The Mermaid envelope versions stay
 * fetchable: a save never rewrites the generated history.
 */
export async function appendCanvasScene(
  auth: DiagramAuth,
  input: { canvasId: string; scene: ExcalidrawScenePayload; title?: string },
): Promise<{ versionNumber: number }> {
  return withTransaction(async (tx) => {
    const [canvas] = await tx
      .select({ id: canvases.id })
      .from(canvases)
      .where(and(eq(canvases.id, input.canvasId), eq(canvases.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!canvas) throw new DiagramError("no canvas with this id in this workspace");

    const nextVersion = await nextCanvasVersionNumber(tx, canvas.id);
    await tx.insert(canvasVersions).values({
      workspaceId: auth.workspaceId,
      canvasId: canvas.id,
      versionNumber: nextVersion,
      scene: { format: "excalidraw", scene: input.scene },
      createdBy: auth.userId,
    });
    if (input.title) {
      await tx.update(canvases).set({ title: input.title, updatedBy: auth.userId }).where(eq(canvases.id, canvas.id));
    }
    return { versionNumber: nextVersion };
  });
}

/*
 * Tool-result budget. capPayload (stream-contract.ts) replaces an over-cap
 * result with a `truncated` marker — which would take the canvasId and
 * artifactId down with it, breaking "Open in canvas" and the artifact link.
 * So the tool echoes the Mermaid source only when the whole serialized result
 * fits the frame cap, and says so explicitly when it drops the source. The
 * source is never lost either way: it rides the frame's tool-args `input` and
 * the persisted artifact version.
 */
export type DiagramToolPayload = {
  ok: true;
  canvasId: string;
  artifactId: string;
  version: number;
  diagramType: DiagramType;
  mermaid?: string;
  mermaidOmitted?: true;
};

export function diagramToolPayload(input: {
  canvasId: string;
  artifactId: string;
  version: number;
  diagramType: DiagramType;
  mermaid: string;
}): DiagramToolPayload {
  const withSource: DiagramToolPayload = { ok: true, ...input };
  if (JSON.stringify(withSource).length <= MAX_TOOL_PAYLOAD) return withSource;
  const { mermaid: _source, ...lean } = input;
  return { ok: true, ...lean, mermaidOmitted: true };
}
