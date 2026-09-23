import { defaultStoreReviewSettingsPolicy } from "@/lib/weletic/reviews/store-settings-contract";
import { expect, it, vi } from "vitest";
import { createMerchantStoreReviewSettingsClient } from "../../../../packages/shopify-app/app/merchant-store-review-settings-client";

const input = {
  expectedRevision: 2,
  expectedInstallationGeneration: "generation-a",
  policy: { ...defaultStoreReviewSettingsPolicy(), enabled: true },
};
const reply = {
  revision: 3,
  installationGeneration: "generation-a",
  productReviewsEnabled: true,
  policy: input.policy,
};
it("requires exact revision, installation and effective policy acknowledgments", async () => {
  const token = vi.fn().mockResolvedValue("fresh-token");
  const fetcher = vi.fn<typeof fetch>();
  const client = createMerchantStoreReviewSettingsClient(token, fetcher);
  for (const bad of [
    { ...reply, revision: 2 },
    { ...reply, installationGeneration: "retired" },
    { ...reply, policy: { ...reply.policy, enabled: false } },
  ]) {
    fetcher.mockResolvedValueOnce(Response.json(bad));
    await expect(client.write(input)).rejects.toThrow();
  }
  fetcher.mockResolvedValueOnce(Response.json(reply));
  await expect(client.write(input)).resolves.toEqual(reply);
  expect(token).toHaveBeenCalledTimes(4);
});
