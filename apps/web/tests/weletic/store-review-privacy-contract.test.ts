import {
  storeReviewAuditRedactionData,
  storeReviewAuditRedactionWhere,
  storeReviewContentRedactionData,
  storeReviewContentRedactionWhere,
  storeReviewRequestRedactionData,
  storeReviewRequestRedactionWhere,
} from "@/lib/weletic/reviews/store-privacy-contract";
import { describe, expect, it } from "vitest";

const customer = {
  kind: "customer" as const,
  storeId: "store-a",
  shopperId: "shopper-a",
};
const now = new Date("2026-09-22T00:00:00Z");
const earlier = new Date("2026-09-21T00:00:00Z");

describe("store-review privacy contract (not runtime erasure evidence)", () => {
  it.each([
    storeReviewContentRedactionWhere,
    storeReviewRequestRedactionWhere,
    storeReviewAuditRedactionWhere,
  ])("rejects blank identities without widening scope", (build) => {
    for (const blank of [
      "",
      "   ",
      " store-a",
      "shopper-a ",
      "x".repeat(192),
    ]) {
      expect(() => build({ ...customer, storeId: blank })).toThrow();
      expect(() => build({ ...customer, shopperId: blank })).toThrow();
      expect(() => build({ kind: "frozen_store", storeId: blank })).toThrow();
    }
  });

  it("discovers content and invitations independently by exact ownership", () => {
    for (const build of [
      storeReviewContentRedactionWhere,
      storeReviewRequestRedactionWhere,
    ]) {
      expect(build(customer)).toMatchObject({
        storeId: "store-a",
        shopperId: "shopper-a",
      });
      expect(build(customer)).not.toHaveProperty("request");
      expect(build(customer)).not.toHaveProperty("review");
      expect(
        build({ kind: "frozen_store", storeId: "store-a" }),
      ).not.toHaveProperty("shopperId");
    }
  });

  it("builds a revision increment while preserving financial/source fields", () => {
    expect(
      storeReviewContentRedactionData({ version: 4, redactedAt: null }, now),
    ).toEqual({
      status: "redacted",
      version: 5,
      title: "",
      body: "",
      displayName: "Redacted customer",
      merchantReply: null,
      participationStatus: "privacy_redacted",
      participationValidatedAt: null,
      participationValidationRevision: null,
      participationContentDigest: null,
      redactedAt: now,
    });
    // An exact patch excludes rewardStatus/ledger/reason, rating and provenance.
  });

  it("preserves first erasure time and saturates terminal versions", () => {
    expect(
      storeReviewContentRedactionData(
        { version: 2147483647, redactedAt: earlier },
        now,
      ),
    ).toMatchObject({
      version: 2147483647,
      redactedAt: earlier,
      status: "redacted",
    });
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2147483648])(
    "rejects corrupt version %s",
    (version) => {
      expect(() =>
        storeReviewContentRedactionData({ version, redactedAt: null }, now),
      ).toThrow();
    },
  );

  it("repairs every cleared content field even after status became redacted", () => {
    const patch = storeReviewContentRedactionData(
      { version: 2, redactedAt: null },
      now,
    );
    const where = storeReviewContentRedactionWhere(customer);
    for (const [field, value] of Object.entries(patch)) {
      if (["version", "redactedAt"].includes(field)) continue;
      expect(where.OR).toContainEqual({ [field]: { not: value } });
    }
    expect(where.OR).toContainEqual({ redactedAt: null });
  });

  it("revokes every invitation secret and lease, including already-cancelled leftovers", () => {
    const patch = storeReviewRequestRedactionData({ cancelledAt: null }, now);
    expect(patch).toEqual({
      status: "cancelled",
      cancelledAt: now,
      cancellationReason: "privacy_redaction",
      tokenHash: null,
      encryptedDeliveryToken: null,
      encryptedDeliverySnapshot: null,
      deliveryToken: null,
      deliveryLeaseExpiresAt: null,
      deliveryReservedAt: null,
      lastError: null,
    });
    for (const [field, value] of Object.entries(patch)) {
      if (field === "cancelledAt") continue;
      expect(storeReviewRequestRedactionWhere(customer).OR).toContainEqual({
        [field]: { not: value },
      });
    }
    expect(storeReviewRequestRedactionWhere(customer).OR).toContainEqual({
      cancellationReason: null,
    });
    expect(
      storeReviewRequestRedactionData({ cancelledAt: earlier }, now)
        .cancelledAt,
    ).toBe(earlier);
  });

  it("scopes customer audit erasure through its same-store content owner", () => {
    expect(storeReviewAuditRedactionWhere(customer)).toMatchObject({
      storeId: "store-a",
      review: { storeId: "store-a", shopperId: "shopper-a" },
    });
    expect(
      storeReviewAuditRedactionWhere({
        kind: "frozen_store",
        storeId: "store-a",
      }),
    ).not.toHaveProperty("review");
  });

  it("repairs audit residues without dropping revision or moderation history", () => {
    const patch = storeReviewAuditRedactionData({ redactedAt: null }, now);
    expect(patch).toEqual({
      reasonDetails: null,
      actorUserId: null,
      merchantActionId: null,
      redactedAt: now,
    });
    for (const field of ["reasonDetails", "actorUserId", "merchantActionId"])
      expect(storeReviewAuditRedactionWhere(customer).OR).toContainEqual({
        [field]: { not: null },
      });
    expect(
      storeReviewAuditRedactionData({ redactedAt: earlier }, now).redactedAt,
    ).toBe(earlier);
  });
});
