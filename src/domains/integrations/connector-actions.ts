import { z } from "zod";
import { executeComposioRead } from "./composio";
import { isRoutineConnectorAction } from "./connector-action-catalog";
import { CONNECTOR_WRITES, type ConnectorActionTool, type ConnectorWriteCapability } from "./connector-action-catalog";
export {
  CONNECTOR_WRITES,
  connectorWrite,
  connectorWriteForTool,
  CONNECTOR_TOOL_DESCRIPTIONS,
} from "./connector-action-catalog";

/** Shared/public destinations require review unless privacy can be proven. */
export async function routineConnectorActionAllowed(
  toolSlug: string,
  args: Record<string, unknown>,
  connectedAccountId: string,
): Promise<boolean> {
  if (!isRoutineConnectorAction(toolSlug)) return false;
  if (toolSlug.startsWith("GITHUB_")) {
    const coordinates = z
      .object({ owner: z.string().regex(/^[A-Za-z0-9_.-]+$/), repo: z.string().regex(/^[A-Za-z0-9_.-]+$/) })
      .safeParse(args);
    if (!coordinates.success) return false;
    try {
      const response = await executeComposioRead({
        connectedAccountId,
        method: "GET",
        endpoint: `https://api.github.com/repos/${coordinates.data.owner}/${coordinates.data.repo}`,
      });
      return response.ok && z.object({ private: z.literal(true) }).safeParse(response.data).success;
    } catch {
      return false;
    }
  }
  if (toolSlug === "SLACK_CREATE_A_REMINDER" && ["user", "user_id"].some((key) => args[key] != null)) return false;
  if (
    toolSlug.startsWith("GOOGLEDRIVE_") &&
    [
      "parents",
      "parent_id",
      "parent_folder_id",
      "parentFolderId",
      "parentId",
      "folder_id",
      "folderId",
      "drive_id",
      "driveId",
      "shared_drive_id",
    ].some((key) => args[key] != null)
  )
    return false;
  return true;
}

export const connectorActionArguments = z.object({
  toolSlug: z.string().regex(/^[A-Z][A-Z0-9_]{1,150}$/),
  arguments: z.record(z.string(), z.unknown()),
  summary: z.string().trim().min(1).max(500),
  accountAlias: z.string().optional(),
});
export const connectorActionPayload = z.object({
  toolSlug: z.string().regex(/^[A-Z][A-Z0-9_]{1,150}$/),
  version: z
    .string()
    .min(1)
    .refine((value) => value !== "latest", "A reviewed action needs a pinned tool version."),
  arguments: z.record(z.string(), z.unknown()),
  summary: z.string().trim().min(1).max(500),
});
export const CONNECTOR_TOOL_SCHEMAS = Object.fromEntries(
  Object.values(CONNECTOR_WRITES).map((spec) => [spec.tool, connectorActionArguments]),
) as Record<ConnectorActionTool, typeof connectorActionArguments>;
export const CONNECTOR_EXECUTORS = Object.fromEntries(
  Object.entries(CONNECTOR_WRITES).map(([capability, spec]) => [
    capability,
    { provider: spec.provider, parse: connectorActionPayload },
  ]),
) as Record<
  ConnectorWriteCapability,
  { provider: (typeof CONNECTOR_WRITES)[ConnectorWriteCapability]["provider"]; parse: typeof connectorActionPayload }
>;

const actionSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().default(""),
  toolkit: z.object({ slug: z.string() }),
  version: z.string().min(1),
  input_parameters: z.record(z.string(), z.unknown()),
  is_deprecated: z.boolean().optional(),
});
const API = "https://backend.composio.dev/api/v3.1/tools";
function headers() {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) throw new Error("Connectors are not configured on this deployment.");
  return { "x-api-key": key, "Content-Type": "application/json" };
}

export async function readConnectorAction(toolkit: string, toolSlug: string, version = "latest") {
  const response = await fetch(`${API}/${encodeURIComponent(toolSlug)}?version=${encodeURIComponent(version)}`, {
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`The connector action could not be verified (${response.status}).`);
  const action = actionSchema.parse(await response.json());
  if (
    action.toolkit.slug !== toolkit ||
    action.slug !== toolSlug ||
    action.is_deprecated ||
    action.version === "latest" ||
    (version !== "latest" && action.version !== version)
  ) {
    throw new Error("This action is unavailable for the selected connector.");
  }
  return action;
}

/** Catalog metadata only; never runs a connected action. */
export async function listConnectorActions(provider: string, search = "") {
  const spec = Object.values(CONNECTOR_WRITES).find((entry) => entry.provider === provider);
  if (!spec) throw new Error("This connector does not support actions.");
  const query = new URLSearchParams({
    toolkit_slug: spec.toolkit,
    query: search,
    limit: "20",
    toolkit_versions: "latest",
    include_deprecated: "false",
  });
  const response = await fetch(`${API}?${query}`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Connector actions could not be loaded (${response.status}).`);
  const body = z.object({ items: z.array(actionSchema) }).parse(await response.json());
  return body.items.filter((action) => action.toolkit.slug === spec.toolkit && !action.is_deprecated);
}

export const connectorObjectResultSchema = z.object({ objectId: z.string().nullable(), url: z.string().nullable() });
export const connectorResponseSummarySchema = z.object({ result: connectorObjectResultSchema });

export type ConnectorActionOutcome =
  | { ok: true; providerObjectId: string | null; label: string; summary: Record<string, unknown> }
  | { ok: false; label: string; rejected: { status: string; message: string } | null; ambiguous: string };

/** Called only after approval, account pin, live permissions, budget, and claim. */
export async function executeConnectorAction(input: {
  connectedAccountId: string;
  payload: z.infer<typeof connectorActionPayload>;
  attemptId: string;
}): Promise<ConnectorActionOutcome> {
  const label = input.payload.summary;
  try {
    const response = await fetch(`${API}/execute/${encodeURIComponent(input.payload.toolSlug)}`, {
      method: "POST",
      headers: headers(),
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        connected_account_id: input.connectedAccountId,
        version: input.payload.version,
        arguments: input.payload.arguments,
      }),
    });
    if (!response.ok) {
      // An unacknowledged write must never be blindly retried.
      return {
        ok: false,
        label,
        rejected: null,
        ambiguous: `The action service returned ${response.status}; verify the external result before retrying.`,
      };
    }
    const parsed = z
      .object({
        successful: z.boolean(),
        data: z.unknown().optional(),
        error: z.unknown().optional(),
        log_id: z.string().optional(),
      })
      .safeParse(await response.json());
    if (!parsed.success)
      return { ok: false, label, rejected: null, ambiguous: "The action service returned an unrecognized result." };
    if (!parsed.data.successful)
      return {
        ok: false,
        label,
        rejected: null,
        ambiguous: "The connector reported an unsuccessful action; verify whether it partially completed.",
      };
    const object = z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        documentId: z.string().optional(),
        spreadsheetId: z.string().optional(),
        url: z.string().optional(),
        html_url: z.string().optional(),
        webUrl: z.string().optional(),
      })
      .safeParse(parsed.data.data);
    const objectId = object.success
      ? (object.data.id ?? object.data.documentId ?? object.data.spreadsheetId ?? null)
      : null;
    const candidateUrl = object.success
      ? (object.data.html_url ?? object.data.webUrl ?? object.data.url ?? null)
      : null;
    const url = candidateUrl && /^https?:\/\//.test(candidateUrl) ? candidateUrl : null;
    return {
      ok: true,
      providerObjectId: objectId === null ? null : String(objectId),
      label,
      summary: {
        toolSlug: input.payload.toolSlug,
        logId: parsed.data.log_id ?? null,
        result: { objectId: objectId === null ? null : String(objectId), url },
      },
    };
  } catch {
    return {
      ok: false,
      label,
      rejected: null,
      ambiguous: "The connector did not confirm the action. Check the external account before retrying.",
    };
  }
}
