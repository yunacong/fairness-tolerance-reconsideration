import { expect, test, type Page } from "@playwright/test";

async function completeParticipant(page: Page) {
  await expect(page.getByRole("heading", { name: /How do people judge fairness/i })).toBeVisible();
  await page.getByRole("button", { name: "Continue to consent" }).click();
  const consentChecks = page.getByRole("checkbox");
  await expect(consentChecks).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) await consentChecks.nth(index).check();
  await page.getByRole("button", { name: /I consent/i }).click();

  await page.getByLabel("Age range").click();
  await page.getByRole("option", { name: "25-34" }).click();
  await page.getByLabel("Gender").click();
  await page.getByRole("option", { name: "prefer not to say" }).click();
  await page.getByLabel("Highest education").click();
  await page.getByRole("option", { name: "postgraduate" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();

  await page.getByRole("checkbox", { name: /actual, predicted, and probability/i }).check();
  await page.getByRole("checkbox", { name: /fairness tolerance is not/i }).check();
  await page.getByRole("button", { name: "Complete tutorial" }).click();
  await page.getByRole("button", { name: /Continue to fairness orientation/i }).click();
  await page.getByRole("button", { name: /Choose a Fairness View/i }).click();

  const viewRadios = page.getByRole("radio");
  await expect(viewRadios).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) await expect(viewRadios.nth(index)).not.toBeChecked();
  await viewRadios.first().focus();
  await page.keyboard.press("Space");
  await expect(viewRadios.first()).toBeChecked();
  await page.getByRole("button", { name: /Confirm selected view/i }).click();

  const preSliders = page.getByRole("slider");
  await preSliders.nth(0).fill("18");
  await preSliders.nth(1).fill("4");
  await page.getByRole("button", { name: /Save PRE decision/i }).click();
  await expect(page.getByRole("img", { name: /fairness disparity and accuracy trade-off/i })).toBeVisible();
  await expect(page.getByRole("table", { name: /accessible model configuration data/i })).toBeVisible();
  await expect(page.getByText(/classification cutoff/i)).toHaveCount(0);
  await page.getByRole("button", { name: /Continue to understanding/i }).click();

  await page.getByRole("radio", { name: /model is always less accurate/i }).check();
  await page.getByRole("radio", { name: /feasible model configuration/i }).check();
  await page.getByRole("button", { name: "Check answers" }).click();
  await expect(page.getByText(/observed difference between the two groups is smaller/i).last()).toBeVisible();
  await page.getByRole("radio", { name: /observed difference between the two groups is smaller/i }).check();
  await page.getByRole("button", { name: "Check again" }).click();

  await page.getByRole("radio", { name: "REVISE" }).check();
  const postSliders = page.getByRole("slider");
  await postSliders.nth(0).fill("22");
  await postSliders.nth(1).fill("5");
  await postSliders.nth(2).fill("4");
  await page.getByLabel(/What influenced your final decision/i).fill("The accuracy information changed what seemed feasible.");
  await page.getByRole("button", { name: "Save final decision" }).click();

  await expect(page.getByRole("heading", { name: "Raw NASA-TLX" })).toBeVisible();
  await page.getByRole("button", { name: /Save Raw NASA-TLX/i }).click();
  await expect(page.getByRole("heading", { name: /System Usability Scale/i })).toBeVisible();
  const susGroups = page.getByRole("radiogroup");
  await expect(susGroups).toHaveCount(10);
  for (let index = 0; index < 10; index += 1) await susGroups.nth(index).getByRole("radio", { name: "4" }).check();
  await page.getByRole("button", { name: /Submit questionnaire and finish/i }).click();

  await expect(page.getByRole("heading", { name: "Study complete" })).toBeVisible();
  const completionCode = (await page.getByText(/^FAIR-[A-F0-9]{4}-[A-F0-9]{4}$/).textContent())!;
  const identity = await page.evaluate(() => ({
    participantId: window.localStorage.getItem("fairness_participant_id"),
    sessionId: window.localStorage.getItem("fairness_session_id"),
  }));
  expect(identity.participantId).toMatch(/^P-[A-F0-9]{12}$/);
  expect(identity.sessionId).toMatch(/^S-[A-F0-9]{12}$/);
  return { ...identity, completionCode };
}

test("local researcher can finish one participant and start another with fresh anonymous identifiers", async ({ page }) => {
  await page.goto("/");
  const first = await completeParticipant(page);

  await expect(page.getByLabel("Local researcher control")).toBeVisible();
  const dialogHandled = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.message()).toBe("Start a new participant on this device? The completed participant data will remain saved.");
    await dialog.accept();
  });
  await Promise.all([
    dialogHandled,
    page.getByRole("button", { name: "Start next participant" }).click(),
  ]);

  await expect(page.getByRole("heading", { name: /How do people judge fairness/i })).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    participantId: window.localStorage.getItem("fairness_participant_id"),
    sessionId: window.localStorage.getItem("fairness_session_id"),
  }))).toEqual({ participantId: null, sessionId: null });

  const second = await completeParticipant(page);
  expect(second.participantId).not.toBe(first.participantId);
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(second.completionCode).not.toBe(first.completionCode);
});
