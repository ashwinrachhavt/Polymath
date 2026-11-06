import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_WRITES,
  connectorActionPayload,
  executeConnectorAction,
  readConnectorAction,
  listConnectorActions,
  routineConnectorActionAllowed,
} from "@/domains/integrations/connector-actions";
import { PROVIDER_TIERS, capabilityAllowed } from "@/domains/integrations/capabilities";
import { isRoutineConnectorAction } from "@/domains/integrations/connector-action-catalog";
import { accessToggleState } from "@/domains/integrations/access-toggles";

const action = {
  slug: "GITHUB_CREATE_AN_ISSUE",
  name: "Create issue",
  toolkit: { slug: "github" },
  version: "20261104_00",
  input_parameters: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("connected actions", () => {
  it("reviews shared/public destinations and sharing-capable actions", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "fixture-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { private: false } })),
    );
    expect(
      await routineConnectorActionAllowed("GITHUB_CREATE_AN_ISSUE", { owner: "owner", repo: "public" }, "account-1"),
    ).toBe(false);
    expect(await routineConnectorActionAllowed("SLACK_CREATE_CANVAS", { channel_id: "C123" }, "account-1")).toBe(false);
    expect(
      await routineConnectorActionAllowed(
        "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT",
        { parent_folder_id: "shared" },
        "account-1",
      ),
    ).toBe(false);
    expect(await routineConnectorActionAllowed("NOTION_CREATE_NOTION_PAGE", { parent_id: "public" }, "account-1")).toBe(
      false,
    );
  });

  it("runs only explicitly classified routine actions directly", () => {
    expect(isRoutineConnectorAction("GITHUB_CREATE_AN_ISSUE")).toBe(true);
    for (const slug of [
      "GITHUB_DELETE_A_REPOSITORY",
      "GOOGLEDRIVE_CREATE_PERMISSION",
      "STRIPE_CREATE_PAYMENT_INTENT",
      "LINKEDIN_CREATE_POST",
      "UNKNOWN_CREATE_RECORD",
    ])
      expect(isRoutineConnectorAction(slug)).toBe(false);
  });

  it("offers opt-in Write for every supported connector without changing read-only grants", () => {
    for (const [capability, spec] of Object.entries(CONNECTOR_WRITES)) {
      expect(accessToggleState(spec.provider, "read_only", []).write).toEqual({
        available: true,
        on: false,
        label: "Write",
      });
      expect(capabilityAllowed(spec.provider, "read_only", [], capability as keyof typeof CONNECTOR_WRITES)).toBe(
        false,
      );
      expect(PROVIDER_TIERS[spec.provider].at(-1)?.capabilities).toContain(capability);
    }
  });
  it("refuses unpinned latest versions in approved payloads", () => {
    expect(
      connectorActionPayload.safeParse({
        toolSlug: action.slug,
        version: "latest",
        arguments: {},
        summary: "Create issue",
      }).success,
    ).toBe(false);
  });
  it("verifies that an action belongs to the chosen connector", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "fixture-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(action)),
    );
    await expect(readConnectorAction("slack", action.slug)).rejects.toThrow(/selected connector/);
    await expect(readConnectorAction("github", action.slug)).resolves.toMatchObject({ version: "20261104_00" });
  });
  it("filters deprecated and wrong-connector results from discovery", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "fixture-key");
    const spy = vi.fn<typeof fetch>(async () =>
      Response.json({ items: [action, { ...action, is_deprecated: true }, { ...action, toolkit: { slug: "slack" } }] }),
    );
    vi.stubGlobal("fetch", spy);
    expect(await listConnectorActions("github", "create issue")).toHaveLength(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("query=create+issue");
  });
  it("keeps unsuccessful or unacknowledged writes unknown rather than retryable", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "fixture-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ successful: false, error: "failed" })),
    );
    const payload = {
      toolSlug: action.slug,
      version: action.version,
      arguments: { title: "Example" },
      summary: "Create example",
    };
    const outcome = await executeConnectorAction({ connectedAccountId: "account-1", attemptId: "attempt-1", payload });
    expect(outcome).toMatchObject({ ok: false, rejected: null });
  });
});
