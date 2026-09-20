import {
  openReviewProvenanceRedactionWhere,
  redactOpenReviewProvenanceBatch,
} from "@/lib/weletic/reviews/open-submission-privacy";
import type { Prisma } from "@prisma/client";
import { expect, it, vi } from "vitest";

it("includes orphan source ownership and secondary original ownership within one store", () => {
  expect(openReviewProvenanceRedactionWhere("store", "shopper")).toEqual({
    storeId: "store",
    AND: [
      {
        OR: [
          { shopperId: "shopper" },
          { review: { storeId: "store", shopperId: "shopper" } },
        ],
      },
    ],
    OR: [{ redactedAt: null }, { contentDigest: { not: null } }],
  });
});

it("does not require a surviving original for whole-store erasure", () => {
  expect(openReviewProvenanceRedactionWhere("store")).toEqual({
    storeId: "store",
    OR: [{ redactedAt: null }, { contentDigest: { not: null } }],
  });
});

it("uses the inclusive predicate for bounded selection and updates while preserving tombstones", async () => {
  const timestamp = new Date("2026-09-01T00:00:00Z");
  const findMany = vi
    .fn()
    .mockResolvedValue([{ id: "source", redactedAt: timestamp }]);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    weleticOpenReviewSubmission: { findMany, updateMany },
  } as unknown as Prisma.TransactionClient;
  await redactOpenReviewProvenanceBatch(tx, "store", "shopper");
  const where = openReviewProvenanceRedactionWhere("store", "shopper");
  expect(findMany).toHaveBeenCalledExactlyOnceWith({
    where,
    orderBy: { id: "asc" },
    take: 20,
    select: { id: true, redactedAt: true },
  });
  expect(updateMany).toHaveBeenCalledExactlyOnceWith({
    where: { ...where, id: "source" },
    data: { contentDigest: null, redactedAt: timestamp },
  });
});

it("does not rewrite a clean page", async () => {
  const findMany = vi.fn().mockResolvedValue([]);
  const updateMany = vi.fn();
  await redactOpenReviewProvenanceBatch(
    {
      weleticOpenReviewSubmission: { findMany, updateMany },
    } as unknown as Prisma.TransactionClient,
    "store",
  );
  expect(updateMany).not.toHaveBeenCalled();
});
