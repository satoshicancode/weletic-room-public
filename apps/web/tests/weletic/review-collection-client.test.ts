import { defaultReviewCollectionPolicy } from "@/lib/weletic/reviews/collection-contract";
import { expect, it, vi } from "vitest";
import { createMerchantAction } from "../../../../packages/shopify-app/app/merchant-action.server";
import { createMerchantReviewCollectionClient as create } from "../../../../packages/shopify-app/app/merchant-review-collection-client";
const api = vi.hoisted(() => vi.fn());
vi.mock("../../../../packages/shopify-app/app/weletic-api.server", () => ({
  weleticApiJson: api,
  WeleticGatewayError: class extends Error {},
}));
const input = {
  expectedRevision: 2,
  expectedInstallationGeneration: "g1",
  policy: defaultReviewCollectionPolicy(),
};
const saved = {
  revision: 3,
  installationGeneration: "g1",
  moduleEnabled: false,
  policy: input.policy,
};
it.each(["read", "write"] as const)(
  "forwards collection %s only with the authenticated actor",
  async (operation) => {
    api.mockReset().mockResolvedValue(saved);
    const actor = { trusted: "server-derived" };
    const authenticate = vi.fn(async (_request, callback) =>
      callback({ actor }),
    );
    const handle = createMerchantAction(
      authenticate,
      `review-collection-${operation}`,
    );
    const body = operation === "read" ? {} : input;
    const response = await handle(
      new Request("http://localhost/api", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(200);
    expect(api).toHaveBeenCalledWith(
      `/api/internal/shopify/merchant/reviews/collection/${operation}`,
      expect.objectContaining({ body: JSON.stringify({ actor, input: body }) }),
    );
    expect((await handle(new Request("http://localhost/api"))).status).toBe(
      405,
    );
    api.mockClear();
    authenticate.mockClear();
    expect(
      (
        await handle(
          new Request("http://localhost/api", {
            method: "POST",
            body: JSON.stringify({ ...body, actor: { storeId: "foreign" } }),
          }),
        )
      ).status,
    ).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  },
);
it("uses fresh tokens, private POST and no cookie authority", async () => {
  const token = vi.fn().mockResolvedValue("token");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(saved));
  const client = create(token, fetcher);
  await client.read();
  await client.write(input);
  expect(token).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenLastCalledWith(
    "/api/merchant/review-collection/write",
    expect.objectContaining({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify(input),
    }),
  );
});
it.each([
  { ...saved, revision: 2 },
  { ...saved, installationGeneration: "other" },
  { ...saved, email: "private" },
  { ...saved, policy: { ...saved.policy, autoPublish: true } },
])("rejects mismatched or private response fields", async (response) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(response));
  await expect(
    create(async () => "token", fetcher).write(input),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each([401, 403, 409, 503])(
  "never repeats uncertain HTTP %s writes",
  async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({}, { status }));
    await expect(
      create(async () => "token", fetcher).write(input),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it("rejects invalid schedules before requesting credentials", async () => {
  const token = vi.fn();
  await expect(
    create(token).write({
      ...input,
      policy: { ...input.policy, reminderAfterDays: [5, 2] },
    }),
  ).rejects.toThrow();
  expect(token).not.toHaveBeenCalled();
});
