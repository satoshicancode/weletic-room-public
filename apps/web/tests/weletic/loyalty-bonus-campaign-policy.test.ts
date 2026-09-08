import {
  assertRunningCampaignImmutability,
  bonusCampaignsOverlap,
  doesOrderLineMatchBonusCampaign,
  normalizeBonusCampaignTargets,
  normalizeEligibleCollectionIds,
  normalizeEligibleSkus,
  normalizeEligibleTierIds,
  parseBonusCampaignSchedule,
} from "@/lib/weletic/loyalty/bonus-campaign-policy";
import { describe, expect, it } from "vitest";

describe("Smile-compatible bonus campaign policy", () => {
  it("enforces the observed 1.5x through 10x multiplier bounds inclusively", () => {
    for (const multiplier of [1.5, 10]) {
      expect(
        parseBonusCampaignSchedule({
          startAt: "2026-09-01T00:00:00.000Z",
          endAt: "2026-09-02T00:00:00.000Z",
          multiplier,
        }),
      ).toMatchObject({ multiplier });
    }

    for (const multiplier of [1.49, 10.01]) {
      expect(() =>
        parseBonusCampaignSchedule({
          startAt: "2026-09-01T00:00:00.000Z",
          endAt: "2026-09-02T00:00:00.000Z",
          multiplier,
        }),
      ).toThrow("between 1.5 and 10");
    }
  });

  it("accepts a 31-day campaign and rejects a longer schedule", () => {
    expect(
      parseBonusCampaignSchedule({
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-10-02T00:00:00.000Z",
        multiplier: 2,
      }),
    ).toMatchObject({ multiplier: 2 });
    expect(() =>
      parseBonusCampaignSchedule({
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-10-02T00:00:00.001Z",
        multiplier: 2,
      }),
    ).toThrow("at most 31 days");
  });

  it("uses half-open windows so adjacent campaigns do not overlap", () => {
    const first = {
      startAt: new Date("2026-09-01T00:00:00.000Z"),
      endAt: new Date("2026-09-08T00:00:00.000Z"),
    };
    expect(
      bonusCampaignsOverlap(first, {
        startAt: new Date("2026-09-07T23:59:59.999Z"),
        endAt: new Date("2026-09-10T00:00:00.000Z"),
      }),
    ).toBe(true);
    expect(
      bonusCampaignsOverlap(first, {
        startAt: first.endAt,
        endAt: new Date("2026-09-10T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  it("deduplicates valid tier IDs and rejects slugs or cross-shape input", () => {
    expect(normalizeEligibleTierIds(["wtier_gold", "wtier_gold"])).toEqual([
      "wtier_gold",
    ]);
    expect(() => normalizeEligibleTierIds(["gold"])).toThrow(
      "invalid VIP tier ID",
    );
    expect(() => normalizeEligibleTierIds("wtier_gold")).toThrow(
      "must be an array",
    );
  });

  it("normalizes and caps canonical SKU and collection targets", () => {
    expect(normalizeEligibleSkus([" SKU-B ", "SKU-A", "SKU-A"])).toEqual([
      "SKU-A",
      "SKU-B",
    ]);
    expect(
      normalizeEligibleCollectionIds([
        "gid://shopify/Collection/42",
        "gid://shopify/Collection/42",
      ]),
    ).toEqual(["gid://shopify/Collection/42"]);
    expect(() => normalizeEligibleCollectionIds(["42"])).toThrow(
      "invalid Shopify collection GID",
    );
    expect(() =>
      normalizeEligibleSkus(Array.from({ length: 101 }, (_, i) => `SKU-${i}`)),
    ).toThrow("at most 100");
    expect(
      normalizeEligibleSkus(Array.from({ length: 101 }, () => "SKU-A")),
    ).toEqual(["SKU-A"]);
  });

  it("matches SKU and collection targets with match-any semantics", () => {
    const targets = normalizeBonusCampaignTargets({
      eligibleSkus: ["SKU-GOLD"],
      eligibleCollectionIds: ["gid://shopify/Collection/123"],
    });

    expect(
      doesOrderLineMatchBonusCampaign({
        targets,
        line: { sku: "SKU-GOLD", collectionExternalIds: [] },
      }),
    ).toBe(true);
    expect(
      doesOrderLineMatchBonusCampaign({
        targets,
        line: {
          sku: "OTHER",
          collectionExternalIds: ["gid://shopify/Collection/123"],
        },
      }),
    ).toBe(true);
    expect(
      doesOrderLineMatchBonusCampaign({
        targets,
        line: { sku: null, collectionExternalIds: null },
      }),
    ).toBe(false);
  });

  it("preserves broadcast behavior when product targets are empty", () => {
    expect(
      doesOrderLineMatchBonusCampaign({
        targets: normalizeBonusCampaignTargets({}),
        line: { sku: null, collectionExternalIds: null },
      }),
    ).toBe(true);
  });

  it("keeps running campaign targeting immutable after canonical normalization", () => {
    const existing = {
      startAt: "2026-09-01T00:00:00.000Z",
      endAt: "2026-09-08T00:00:00.000Z",
      multiplier: 2,
      eligibleTierIds: ["wtier_gold"],
      eligibleSkus: ["SKU-B", "SKU-A"],
      eligibleCollectionIds: ["gid://shopify/Collection/42"],
    };
    const now = new Date("2026-09-05T00:00:00.000Z");

    expect(() =>
      assertRunningCampaignImmutability({
        existing,
        updates: { eligibleSkus: [" SKU-A ", "SKU-B", "SKU-A"] },
        now,
      }),
    ).not.toThrow();
    expect(() =>
      assertRunningCampaignImmutability({
        existing,
        updates: { eligibleCollectionIds: ["gid://shopify/Collection/99"] },
        now,
      }),
    ).toThrow("cannot have their targeting modified");
  });
});
