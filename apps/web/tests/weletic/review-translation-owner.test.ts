import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { ReviewOwnerPrivacySuppressedError } from "../../lib/weletic/reviews/privacy-owner-write";
import { assertReviewTranslationOwnerAvailable } from "../../lib/weletic/reviews/translation-owner";

const guard = vi.hoisted(() => vi.fn());
vi.mock("../../lib/weletic/reviews/privacy-owner-write", () => ({
  lockReviewOwnerPrivacySource: guard,
  ReviewOwnerPrivacySuppressedError: class extends Error {},
}));
const input = {
  tx: {} as Prisma.TransactionClient,
  storeId: "store_1",
  shopperId: "shopper_1",
  installationGeneration: "g1",
};
beforeEach(() => vi.resetAllMocks());
it("uses the existing same-transaction guard without writing coverage", async () => {
  guard.mockResolvedValue({ privateProof: "must-not-escape" });
  expect(await assertReviewTranslationOwnerAvailable(input)).toBeUndefined();
  expect(guard).toHaveBeenCalledWith(input);
});
it("maps only authoritative suppression to not_found", async () => {
  guard.mockRejectedValue(new ReviewOwnerPrivacySuppressedError());
  await expect(
    assertReviewTranslationOwnerAvailable(input),
  ).rejects.toMatchObject({
    code: "not_found",
    message: "Review unavailable",
  });
});
it("preserves unknown/key/storage errors as failures", async () => {
  const error = new Error("Review privacy source unavailable");
  guard.mockRejectedValue(error);
  await expect(assertReviewTranslationOwnerAvailable(input)).rejects.toBe(
    error,
  );
});
