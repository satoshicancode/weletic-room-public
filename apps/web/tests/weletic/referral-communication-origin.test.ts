import {
  createReferralCommunicationOrigin,
  readReferralCommunicationOrigin,
  referralBenefitCommunicationKey,
  referralCommunicationOriginSchema,
} from "@/lib/weletic/loyalty/referral-communication-origin";
import { describe, expect, it } from "vitest";

const identity = {
  storeId: "store-1",
  programId: "program-1",
  referralId: "referral-1",
  qualificationOrderId: "order-1",
  accountId: "account-1",
  side: "advocate" as const,
};
const input = {
  ...identity,
  installationGeneration: "generation-1",
  qualificationPath: "account_referral" as const,
  qualifiedAt: "2026-09-13T00:00:00.000Z",
  kind: "points" as const,
  points: "150",
};
const origin = () => createReferralCommunicationOrigin(input);
const metadata = (value: unknown) => ({
  referralCommunicationOrigins: { advocate: value },
});

describe("referral communication qualification provenance", () => {
  it("round trips original generation and exact points without current credentials", () => {
    const value = createReferralCommunicationOrigin({
      ...input,
      points: "9223372036854775807",
    });
    expect(
      readReferralCommunicationOrigin({ metadata: metadata(value), identity }),
    ).toEqual(value);
    expect(value.installationGeneration).toBe("generation-1");
  });

  it("supports either account-backed side and the preissued-claim advocate", () => {
    expect(
      createReferralCommunicationOrigin({ ...input, side: "referee" }).side,
    ).toBe("referee");
    expect(
      createReferralCommunicationOrigin({
        ...input,
        qualificationPath: "preissued_friend_claim",
      }).side,
    ).toBe("advocate");
    expect(() =>
      createReferralCommunicationOrigin({
        ...input,
        side: "referee",
        qualificationPath: "preissued_friend_claim",
      }),
    ).toThrow();
  });

  it("binds coupons to the immutable reward snapshot without codes or recipients", () => {
    const { points: _points, kind: _kind, ...common } = input;
    const coupon = createReferralCommunicationOrigin({
      ...common,
      kind: "coupon",
      rewardDefinitionId: "reward-1",
      rewardSnapshotDigest: "A".repeat(64),
    });
    expect(
      readReferralCommunicationOrigin({ metadata: metadata(coupon), identity }),
    ).toEqual(coupon);
    expect(
      referralCommunicationOriginSchema.safeParse({
        ...coupon,
        rewardSnapshotDigest: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      referralCommunicationOriginSchema.safeParse({ ...coupon, points: "150" })
        .success,
    ).toBe(false);
  });

  it.each([
    null,
    undefined,
    {},
    { referralCommunicationOrigins: {} },
    { referralCommunicationOrigins: { referee: origin() } },
  ])("does not backfill an absent side in legacy metadata %#", (value) => {
    expect(
      readReferralCommunicationOrigin({ metadata: value, identity }),
    ).toBeNull();
  });

  it("keeps coupon receipt keys stable and separate from points", () => {
    const { points: _points, kind: _kind, ...common } = input;
    const coupon = createReferralCommunicationOrigin({
      ...common,
      kind: "coupon",
      rewardDefinitionId: "reward-1",
      rewardSnapshotDigest: "A".repeat(64),
    });
    const key = referralBenefitCommunicationKey(coupon, "receipt-1");
    expect(referralBenefitCommunicationKey(coupon, "receipt-1")).toBe(key);
    expect(referralBenefitCommunicationKey(origin(), "receipt-1")).not.toBe(
      key,
    );
    expect(referralBenefitCommunicationKey(coupon, "receipt-2")).not.toBe(key);
    for (const [field, value] of [
      ["rewardDefinitionId", ""],
      ["rewardDefinitionId", "x".repeat(192)],
      ["rewardSnapshotDigest", "A".repeat(63)],
      ["rewardSnapshotDigest", "G".repeat(64)],
    ]) {
      expect(
        referralCommunicationOriginSchema.safeParse({
          ...coupon,
          [field]: value,
        }).success,
      ).toBe(false);
    }
  });

  it.each([
    null,
    [],
    "invalid",
    { unknownSide: origin() },
    { advocate: null },
    { advocate: { ...origin(), version: 2 } },
  ])("rejects present invalid provenance %#", (value) => {
    expect(() =>
      readReferralCommunicationOrigin({
        metadata: { referralCommunicationOrigins: value },
        identity,
      }),
    ).toThrow("Referral communication origin unavailable");
  });

  it.each([
    "storeId",
    "programId",
    "referralId",
    "qualificationOrderId",
    "accountId",
    "side",
  ] as const)("rejects mismatched %s", (field) => {
    const value = {
      ...origin(),
      [field]: field === "side" ? "referee" : "other",
    };
    expect(() =>
      readReferralCommunicationOrigin({ metadata: metadata(value), identity }),
    ).toThrow();
  });

  it.each(["0", "-1", "1.5", "01", "1e3", "9223372036854775808", "", "NaN"])(
    "rejects invalid points %s",
    (points) => {
      expect(() =>
        createReferralCommunicationOrigin({ ...input, points }),
      ).toThrow();
    },
  );

  it.each(["email", "discountCode", "applyUrl", "refereeAccountId"])(
    "rejects an extra recipient or cross-party field %s",
    (field) => {
      expect(
        referralCommunicationOriginSchema.safeParse({
          ...origin(),
          [field]: "private",
        }).success,
      ).toBe(false);
    },
  );

  it("rejects absent/bounded identity, generation and invalid occurrence time", () => {
    for (const [field, value] of [
      ["accountId", ""],
      ["storeId", "x".repeat(192)],
      ["installationGeneration", ""],
      ["installationGeneration", "x".repeat(65)],
      ["qualifiedAt", "invalid"],
    ]) {
      expect(
        referralCommunicationOriginSchema.safeParse({
          ...origin(),
          [field]: value,
        }).success,
      ).toBe(false);
    }
  });

  it("keys the actual side/receipt/order/generation without a mutable occurrence time", () => {
    const value = origin();
    const key = referralBenefitCommunicationKey(value, "ledger-1");
    expect(key).toMatch(
      /^loyalty_communication:referral_benefit:[a-f0-9]{64}$/,
    );
    expect(
      referralBenefitCommunicationKey(
        { ...value, qualifiedAt: "2026-09-14T00:00:00.000Z" },
        "ledger-1",
      ),
    ).toBe(key);
    expect(referralBenefitCommunicationKey(value, "ledger-2")).not.toBe(key);
    for (const field of [
      "storeId",
      "programId",
      "referralId",
      "qualificationOrderId",
      "accountId",
      "installationGeneration",
    ] as const) {
      expect(
        referralBenefitCommunicationKey(
          { ...value, [field]: "other" },
          "ledger-1",
        ),
      ).not.toBe(key);
    }
    expect(
      referralBenefitCommunicationKey(
        { ...value, side: "referee" },
        "ledger-1",
      ),
    ).not.toBe(key);
    expect(() => referralBenefitCommunicationKey(value, "")).toThrow();
  });
});
