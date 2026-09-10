import { expect, test } from "@playwright/test";

test("waitlist preserves rejected input and accepts a keyboard retry", async ({
  page
}) => {
  test.skip(
    !process.env.LANDING_E2E_URL,
    "Start the landing app and set LANDING_E2E_URL to run this cross-app check."
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let attempts = 0;
  await page.route("**/api/waitlist", async (route) => {
    attempts += 1;
    expect(route.request().headers().accept).toBe("application/json");
    await route.fulfill({
      status: attempts === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify({ status: attempts === 1 ? "error" : "joined" })
    });
  });
  await page.goto(process.env.LANDING_E2E_URL!);
  const documents = page.getByRole("button", { name: "Shared documents" });
  await documents.click();
  await expect(documents).toHaveAttribute("aria-pressed", "true");
  const email = page.getByRole("textbox", { name: "Email address" });
  await email.fill("tester@example.com");
  await email.press("Enter");
  await expect(
    page.getByRole("alert").filter({
      hasText: "We couldn't save your place. Please try again."
    })
  ).toBeVisible();
  await expect(email).toHaveValue("tester@example.com");
  await expect(
    page.getByText("You're on the orchestrat waitlist.")
  ).toHaveCount(0);
  await email.press("Enter");
  await expect(
    page.getByText("You're on the orchestrat waitlist.")
  ).toBeVisible();
  expect(attempts).toBe(2);
  expect(errors).toEqual([]);
});
