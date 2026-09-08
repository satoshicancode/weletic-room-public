import { nanoid } from "@dub/utils";
import { test as base, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { extractOtp, waitForEmail } from "../mailhog";

const createdWorkspaceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  plan: z.literal("free"),
});

/** Every test attempt (including retries) owns a new verified user and cookie jar. */
export const test = base.extend<{
  workspace: z.infer<typeof createdWorkspaceSchema>;
}>({
  storageState: { cookies: [], origins: [] },
  page: [
    async ({ page }, use) => {
      const email = `${nanoid(20)}@dub-internal-test.com`;
      await page.goto("/register");
      await page.locator('input[name="email"]').fill(email);
      await page.getByRole("button", { name: "Sign Up" }).click();
      const password = page.locator('input[name="password"]');
      await expect(password).toBeVisible();
      await password.fill("Password123");
      await page.getByRole("button", { name: "Sign Up" }).click();
      await expect(
        page.getByRole("heading", { name: "Verify your email address" }),
      ).toBeVisible();
      await page.keyboard.type(extractOtp(await waitForEmail(email)));
      await expect(page).toHaveURL(/\/onboarding/, { timeout: 30_000 });

      // A new browser context alone is insufficient if storageState restores a
      // quota-bearing shared account. Assert the authenticated server state too.
      // Middleware may redirect localhost to app.localhost. APIRequestContext
      // resolves relative URLs against baseURL, not the authenticated page, and
      // the host-only session cookie must never be copied to the other origin.
      const workspaces = await page.request.get(
        new URL("/api/workspaces", page.url()).href,
      );
      expect(workspaces.status()).toBe(200);
      expect(await workspaces.json()).toEqual([]);
      await use(page);
    },
    { timeout: 60_000 },
  ],
  workspace: async ({ page }, use) => {
    const slug = `e2e-billing-${randomUUID()}`;
    const response = await page.request.post(
      new URL("/api/workspaces", page.url()).href,
      {
        data: { name: "Billing test workspace", slug },
      },
    );
    expect(response.ok()).toBe(true);
    const workspace = createdWorkspaceSchema.parse(await response.json());
    expect(workspace.slug).toBe(slug);
    await use(workspace);
  },
});

export { expect } from "@playwright/test";
