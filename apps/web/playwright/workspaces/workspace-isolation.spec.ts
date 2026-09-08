import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures";

test("an isolated user retains the real two-free-workspace limit", async ({
  page,
}) => {
  // Deliberately exhaust this attempt's allowance. Other tests and retries must
  // still begin with the empty authenticated workspace list checked by fixtures.
  const workspaceUrl = new URL("/api/workspaces", page.url()).href;
  for (let index = 0; index < 2; index++) {
    const response = await page.request.post(workspaceUrl, {
      data: {
        name: "Quota isolation",
        slug: `e2e-quota-${randomUUID()}`,
      },
    });
    expect(response.ok()).toBe(true);
  }
  const response = await page.request.post(workspaceUrl, {
    data: { name: "Over quota", slug: `e2e-quota-${randomUUID()}` },
  });
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({
    error: { code: "exceeded_limit" },
  });
});
