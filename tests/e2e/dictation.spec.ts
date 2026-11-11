import { expect, test, type Page } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

/*
 * Dictation from the outside: Right Option records from Chromium's fake
 * microphone, the clip goes to /api/v1/speech/transcriptions, the
 * deterministic fixture adapter answers, and the words land at the caret of
 * whatever field was focused, editable and unsent. Needs the server booted
 * with TRANSCRIPTION_PROVIDER=fixture, as CI's e2e job is.
 */

const FIXTURE = "Fixture transcript: send the Q3 roadmap to Priya by Friday and confirm the launch date.";
const TRANSCRIPTIONS = "/api/v1/speech/transcriptions";
// The first upload compiles the route under `next dev`; later ones answer at once.
const ANSWERED = { timeout: 30_000 };

// The answer wait (ANSWERED) has to fit inside the test's own budget, or a cold
// compile fails the first try however long the assertion is willing to wait.
test.setTimeout(90_000);

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["microphone"]);
});

/** Counts dictation uploads, so a journey can prove none was made. */
function countUploads(page: Page) {
  const seen = { count: 0 };
  page.on("request", (request) => {
    if (request.url().includes(TRANSCRIPTIONS)) seen.count += 1;
  });
  return seen;
}

async function controllerReady(page: Page) {
  await expect(page.getByRole("status", { name: "Dictation" })).toBeAttached({ timeout: 15_000 });
}

/** Speech is captured only once the pill says Listening, as it is for a person. */
async function hold(page: Page, ms = 600) {
  await page.keyboard.down("AltRight");
  await expect(page.getByRole("status", { name: "Dictation" })).toContainText("Listening");
  await page.waitForTimeout(ms);
  await page.keyboard.up("AltRight");
}

/** The modal dialog hides the status pill from the accessibility tree, so wait on the element itself. */
async function microphoneOpen(page: Page) {
  await expect(page.locator("[data-dictation]")).toContainText("Tap Right Option to stop");
}

async function tap(page: Page) {
  await page.keyboard.down("AltRight");
  await page.keyboard.up("AltRight");
}

async function openComposer(page: Page) {
  await page.goto("/polymath");
  await waitSettled(page);
  await controllerReady(page);
  const composer = page.getByLabel("Start a conversation");
  await composer.click();
  return composer;
}

test("holding Right Option in the chat composer inserts the words at the caret and sends nothing", async ({ page }) => {
  const composer = await openComposer(page);
  await composer.pressSequentially("abc");
  await hold(page);
  await expect(composer).toHaveValue(`abc ${FIXTURE}`, ANSWERED);
  // Nothing was sent: the composer still holds the words and the send button is ready for the person.
  await expect(page).toHaveURL(/\/polymath$/);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(page.getByRole("status", { name: "Dictation" })).not.toContainText(/Listening|Transcribing/);

  // One undo removes the dictated words and nothing typed before them.
  await composer.press("ControlOrMeta+z");
  await expect(composer).toHaveValue("abc");
});

test("dictation fills an uncontrolled form field", async ({ page }) => {
  await page.goto("/command-center/relationships/people");
  await waitSettled(page);
  await controllerReady(page);
  await page.getByText("New contact", { exact: true }).click();
  const notes = page.locator('textarea[name="notes"]');
  await notes.click();
  await notes.pressSequentially("met at the summit.");
  await hold(page);
  await expect(notes).toHaveValue(`met at the summit. ${FIXTURE}`, ANSWERED);
  await notes.press("ControlOrMeta+z");
  await expect(notes).toHaveValue("met at the summit.");
});

/** A fresh, empty note, opened by its own URL. */
async function openNewNote(page: Page) {
  await page.goto("/polymath/notes");
  await page.waitForLoadState("networkidle");
  // Bare /polymath/notes may already show the latest note's id; wait for a different one.
  const previousUrl = page.url();
  await page.getByRole("button", { name: "New note" }).first().click();
  await expect(page).not.toHaveURL(previousUrl, { timeout: 30_000 });
  await expect(page).toHaveURL(/\/polymath\/notes\?id=[0-9a-f-]{36}/);
  // Load it directly: right after New note the previous note can still be on
  // screen, and its late swap would wipe whatever was typed.
  await page.goto(page.url());
  await controllerReady(page);
  const editor = page.getByLabel("Rich note content");
  await expect(editor).toHaveText("");
  await editor.click();
  return editor;
}

test("dictation writes into the note editor, which saves it like typing", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await openNewNote(page);
  await page.keyboard.type("first");
  await expect(editor).toContainText("first");
  // Let the typed word's save land first, so the save after dictation is the only one in flight.
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
  await hold(page);
  await expect(editor).toContainText(`first ${FIXTURE}`, ANSWERED);
  // The editor's own change pipeline saw it: the note goes dirty, autosaves, and reloads with the words.
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByLabel("Rich note content")).toContainText(`first ${FIXTURE}`, { timeout: 15_000 });
});

test("one undo in the note editor removes only the dictated words", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await openNewNote(page);
  await page.keyboard.type("first");
  await expect(editor).toContainText("first");
  await hold(page);
  await expect(editor).toContainText(`first ${FIXTURE}`, ANSWERED);
  await editor.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("Fixture transcript");
  await expect(editor).toHaveText("first");
});

test("a tap latches listening on and the next tap stops it, inserting once", async ({ page }) => {
  const uploads = countUploads(page);
  const composer = await openComposer(page);
  await tap(page);
  const status = page.getByRole("status", { name: "Dictation" });
  await expect(status).toContainText("Tap Right Option to stop");
  await page.waitForTimeout(500);
  await tap(page);
  await expect(composer).toHaveValue(FIXTURE, ANSWERED);
  await expect(status).not.toContainText(/Listening|Transcribing/);
  expect(uploads.count).toBe(1);
});

test("Escape cancels: nothing is uploaded or inserted", async ({ page }) => {
  const uploads = countUploads(page);
  const composer = await openComposer(page);
  await composer.pressSequentially("draft");
  await tap(page);
  const status = page.getByRole("status", { name: "Dictation" });
  await expect(status).toContainText("Listening");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await expect(status).not.toContainText("Listening");
  await page.waitForTimeout(1000);
  await expect(composer).toHaveValue("draft");
  expect(uploads.count).toBe(0);
});

test("with no field focused, the key shows a hint and records nothing", async ({ page }) => {
  const uploads = countUploads(page);
  await page.goto("/polymath");
  await waitSettled(page);
  await controllerReady(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down("AltRight");
  await page.waitForTimeout(400);
  await page.keyboard.up("AltRight");
  const status = page.getByRole("status", { name: "Dictation" });
  await expect(status).toContainText("Click into a text field first");
  await expect(status).not.toContainText("Listening");
  await page.waitForTimeout(800);
  expect(uploads.count).toBe(0);
});

test("Alt+ArrowRight is a shortcut, not dictation", async ({ page }) => {
  const uploads = countUploads(page);
  const composer = await openComposer(page);
  await composer.pressSequentially("abc");
  await page.keyboard.down("AltRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  await page.keyboard.up("AltRight");
  await page.waitForTimeout(800);
  await expect(page.getByRole("status", { name: "Dictation" })).not.toContainText(/Listening|Transcribing/);
  await expect(composer).toHaveValue("abc");
  expect(uploads.count).toBe(0);
});

test("a failed clip is kept and Retry sends it again without re-recording", async ({ page }) => {
  let attempts = 0;
  await page.route(`**${TRANSCRIPTIONS}`, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 502,
        contentType: "application/problem+json",
        body: JSON.stringify({ code: "transcription_failed", status: 502 }),
      });
    } else {
      await route.continue();
    }
  });
  const composer = await openComposer(page);
  await hold(page);
  const status = page.getByRole("status", { name: "Dictation" });
  await expect(status).toContainText("Transcription failed", ANSWERED);
  await expect(composer).toHaveValue("");
  await status.getByRole("button", { name: "Retry" }).click();
  await expect(composer).toHaveValue(FIXTURE, ANSWERED);
  expect(attempts).toBe(2);
  await expect(status).not.toContainText("Transcription failed");
});

test("the composer's mic button latches listening with the caret in place and a second click inserts once", async ({
  page,
}) => {
  const uploads = countUploads(page);
  const composer = await openComposer(page);
  await composer.pressSequentially("abc");
  await page.getByRole("button", { name: "Dictate" }).click();
  const status = page.getByRole("status", { name: "Dictation" });
  await expect(status).toContainText("Tap Right Option to stop");
  await expect(composer).toBeFocused();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Stop dictating" }).click();
  await expect(composer).toHaveValue(`abc ${FIXTURE}`, ANSWERED);
  await expect(composer).toBeFocused();
  await expect(page).toHaveURL(/\/polymath$/);
  await expect(page.getByRole("button", { name: "Dictate" })).toBeEnabled();
  expect(uploads.count).toBe(1);
});

test("the note editor's mic button dictates into the note", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await openNewNote(page);
  await page.keyboard.type("first");
  await expect(editor).toContainText("first");
  await page.getByRole("button", { name: "Dictate" }).click();
  await expect(page.getByRole("status", { name: "Dictation" })).toContainText("Tap Right Option to stop");
  await expect(editor).toBeFocused();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Stop dictating" }).click();
  await expect(editor).toContainText(`first ${FIXTURE}`, ANSWERED);
});

test("the capture dialog's why field fills through its mic button and the capture is saved as dictated", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  await controllerReady(page);
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const unique = `e2e-dictated-why-${Date.now()}`;
  await dialog.getByLabel("Anything worth keeping").fill(unique);
  const why = dialog.getByLabel("Why does this matter?");
  await dialog.getByRole("button", { name: "Dictate" }).click();
  await microphoneOpen(page);
  await page.waitForTimeout(500);
  await dialog.getByRole("button", { name: "Stop dictating" }).click();
  await expect(why).toHaveValue(FIXTURE, ANSWERED);

  await dialog.getByRole("button", { name: "Save capture" }).click();
  await expect(dialog).toBeHidden();
  await page.getByText(unique, { exact: false }).first().click();
  const detail = page.getByRole("article");
  await expect(detail.getByRole("region", { name: "Capture context" })).toContainText(FIXTURE);
  await expect(detail.getByRole("region", { name: "Capture context" })).toContainText("dictated");
});

test("retyping the dictated why saves it as typed", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  await controllerReady(page);
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const unique = `e2e-typed-why-${Date.now()}`;
  await dialog.getByLabel("Anything worth keeping").fill(unique);
  const why = dialog.getByLabel("Why does this matter?");
  await dialog.getByRole("button", { name: "Dictate" }).click();
  await microphoneOpen(page);
  await page.waitForTimeout(500);
  await dialog.getByRole("button", { name: "Stop dictating" }).click();
  await expect(why).toHaveValue(FIXTURE, ANSWERED);
  await why.press("End");
  await why.pressSequentially("!");

  await dialog.getByRole("button", { name: "Save capture" }).click();
  await expect(dialog).toBeHidden();
  await page.getByText(unique, { exact: false }).first().click();
  const context = page.getByRole("article").getByRole("region", { name: "Capture context" });
  await expect(context).toContainText(`${FIXTURE}!`);
  await expect(context).not.toContainText("dictated");
});

test("words still land at the note's caret when focus has moved to another field by the time they arrive", async ({
  page,
}) => {
  let answer!: () => void;
  const held = new Promise<void>((resolve) => (answer = resolve));
  await page.route(`**${TRANSCRIPTIONS}`, async (route) => {
    await held;
    await route.continue();
  });
  const editor = await openNewNote(page);
  await page.keyboard.type("alpha beta");
  for (let i = 0; i < " beta".length; i += 1) await page.keyboard.press("ArrowLeft");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
  await hold(page);
  const title = page.getByLabel("Note title");
  await title.click();
  answer();
  await expect(editor).toContainText(`alpha ${FIXTURE} beta`, ANSWERED);
  await expect(title).not.toHaveValue(/Fixture transcript/);
  await expect(title).toBeFocused();
});

test("inside the capture dialog, Retry on the pill works and leaves the dialog open", async ({ page }) => {
  test.setTimeout(90_000);
  let attempts = 0;
  await page.route(`**${TRANSCRIPTIONS}`, async (route) => {
    attempts += 1;
    if (attempts === 1) await route.fulfill({ status: 502, contentType: "application/problem+json", body: "{}" });
    else await route.continue();
  });
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  await controllerReady(page);
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const why = dialog.getByLabel("Why does this matter?");
  await dialog.getByRole("button", { name: "Dictate" }).click();
  await microphoneOpen(page);
  await page.waitForTimeout(500);
  await dialog.getByRole("button", { name: "Stop dictating" }).click();

  const pill = page.locator("[data-dictation]");
  await expect(pill).toContainText("Transcription failed");
  // A real pointer press: this fails if the dialog's overlay covers the pill
  // or the page's pointer events are off.
  await pill.getByRole("button", { name: "Retry", includeHidden: true }).click();
  await expect(why).toHaveValue(FIXTURE, ANSWERED);
  await expect(dialog).toBeVisible();
  expect(attempts).toBe(2);
});
