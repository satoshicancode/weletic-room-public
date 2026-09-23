import { expect, it, vi } from "vitest";
import { createMerchantStoreReviewsClient } from "../../../../packages/shopify-app/app/merchant-store-reviews-client";

const input = {
  reviewId: "review-a",
  version: 2,
  status: "published" as const,
  reason: "approved" as const,
};
const ack = {
  reviewId: "review-a",
  auditId: "audit-a",
  version: 3,
  status: "published",
};

it("accepts only the next audited version and requested moderation status", async () => {
  const token = vi.fn().mockResolvedValue("fresh-token");
  const transport = vi.fn<typeof fetch>();
  const client = createMerchantStoreReviewsClient(token, transport);
  for (const bad of [
    { ...ack, reviewId: "other" },
    { ...ack, version: 2 },
    { ...ack, version: 4 },
    { ...ack, status: "hidden" },
  ]) {
    transport.mockResolvedValueOnce(Response.json(bad));
    await expect(client.moderate(input)).rejects.toThrow();
  }
  transport.mockResolvedValueOnce(Response.json(ack));
  await expect(client.moderate(input)).resolves.toEqual(ack);
  expect(token).toHaveBeenCalledTimes(5);
  expect(transport).toHaveBeenCalledTimes(5);
});
