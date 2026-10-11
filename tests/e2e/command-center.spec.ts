import { expect, test } from "@playwright/test";
import { sampleState } from "../../src/components/workspace/sample-state";

const records = [
  { screen: "contacts", id: "contact-1", title: "Morgan Chen", missing: "Contact not found" },
  { screen: "companies", id: "company-1", title: "Northstar Labs", missing: "Company not found" },
  { screen: "opportunities", id: "opportunity-1", title: "Senior systems engineer", missing: "Opportunity not found" },
];

for (const record of records) {
  test(`${record.screen} record deep link opens the exact inspector and can close`, async ({ page }) => {
    await page.goto(`/apps/command-center/${record.screen}?id=${record.id}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: record.title, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: record.title, exact: true }).click();
    await expect(dialog.getByRole("heading", { name: record.title, exact: true })).toBeVisible();
  });

  test(`${record.screen} unknown deep link reports missing without selecting a fallback`, async ({ page }) => {
    await page.goto(`/apps/command-center/${record.screen}?id=does-not-exist`);
    await expect(page.getByText(record.missing, { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

test("a browser-created contact deep link resolves after stored preview hydration", async ({ page }) => {
  const id = "browser-contact";
  const name = "Preview-only contact";
  await page.addInitScript((state) => localStorage.setItem("axiom-ui-preview-v1", JSON.stringify(state)), {
    ...sampleState,
    contacts: [{ ...sampleState.contacts[0], id, name }, ...sampleState.contacts],
  });
  await page.goto(`/apps/command-center/contacts?id=${id}`);
  await expect(page.getByRole("dialog").getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText("Contact not found", { exact: true })).not.toBeVisible();
});

test("ambiguous repeated record ids are rejected instead of choosing the first contact", async ({ page }) => {
  await page.goto("/apps/command-center/contacts?id=contact-1&id=contact-2");
  await expect(page.getByText("Contact not found", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
