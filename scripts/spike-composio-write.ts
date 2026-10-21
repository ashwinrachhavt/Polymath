/*
 * One-shot spike: does the Composio proxy forward a POST?
 *
 * Everything about the send path (Task 7/8) rests on this. `executeComposioRead`
 * only proves GET; a proxy that silently drops POST bodies would make the
 * executor look correct in tests and do nothing in production. Run this once
 * with a live connected account, paste the result into the spec's §2 table, and
 * delete the script.
 *
 * Sends to the owner's own address only. Never logs the key, the connected
 * account id, or response headers.
 *
 *   COMPOSIO_API_KEY=… POLYMATH_SPIKE_ACCOUNT=ca_… POLYMATH_SPIKE_TO=you@example.com \
 *     pnpm tsx scripts/spike-composio-write.ts
 */
import { randomUUID } from "node:crypto";

const EXECUTE_PROXY_URL = "https://backend.composio.dev/api/v3/tools/execute/proxy";
const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

function base64url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** RFC 2822, minimal but valid. The marker makes the message findable by reconciliation. */
function buildMessage(to: string, marker: string) {
  const lines = [
    `To: ${to}`,
    "From: me",
    `Subject: Polymath gateway spike ${marker}`,
    `Message-ID: <${marker}@polymath.invalid>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "This is a one-off check that the Composio proxy forwards POST. It is safe to delete.",
  ];
  return lines.join("\r\n");
}

async function main() {
  const apiKey = process.env.COMPOSIO_API_KEY;
  const accountId = process.env.POLYMATH_SPIKE_ACCOUNT;
  const to = process.env.POLYMATH_SPIKE_TO;

  if (!apiKey || !accountId || !to) {
    console.error("Needs COMPOSIO_API_KEY, POLYMATH_SPIKE_ACCOUNT, POLYMATH_SPIKE_TO.");
    process.exit(2);
  }
  if (!apiKey.startsWith("ak_")) console.error("warning: key does not look like a Composio project key");

  const marker = `polymath-spike-${randomUUID()}`;
  const raw = base64url(buildMessage(to, marker));

  const started = Date.now();
  const response = await fetch(EXECUTE_PROXY_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      connected_account_id: accountId,
      endpoint: SEND_ENDPOINT,
      method: "POST",
      body: { raw },
      parameters: [],
    }),
  });
  const elapsed = Date.now() - started;
  const text = await response.text();

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // reported below as an unparseable body
  }

  const body = parsed as { data?: { id?: string; threadId?: string }; error?: unknown } | null;
  const forwarded = response.ok && typeof body?.data?.id === "string";

  console.log(JSON.stringify({
    forwarded,
    httpStatus: response.status,
    elapsedMs: elapsed,
    providerMessageId: body?.data?.id ?? null,
    threadId: body?.data?.threadId ?? null,
    marker,
    shape: forwarded ? "data.id, data.threadId" : "see error",
    error: forwarded ? null : (body?.error ?? text.slice(0, 300)),
  }, null, 2));

  console.log(
    forwarded
      ? "\nThe proxy forwards POST. Record this in the spec §2 table, then delete this script."
      : "\nThe proxy did NOT forward POST. Take the documented fallback in plan Task 1: call Gmail's API directly with a token from Composio's connected-account endpoint, behind src/domains/integrations/gmail/send.ts.",
  );
  process.exit(forwarded ? 0 : 1);
}

main().catch((error) => {
  console.error("spike failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
