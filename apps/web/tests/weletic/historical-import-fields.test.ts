import {
  captureHistoricalImportFields,
  planHistoricalImportBirthday,
  planHistoricalImportFieldRestoration,
  type HistoricalImportFieldAccount,
} from "@/lib/weletic/loyalty/historical-import-fields";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

function fixture(): HistoricalImportFieldAccount {
  return {
    id: "account",
    storeId: "store",
    programId: "program",
    metadata: { unrelated: "initial" },
    currentTierId: null,
    tierExpiresAt: null,
    lastQualifyingActivityAt: null,
    nextExpiryDate: null,
    pointsExpiryPolicyVersion: 0,
    pointsExpiryJobsScheduledAt: null,
  };
}
describe("import field rollback plan", () => {
  it("restores birthday, tier and expiry fields while preserving current unrelated metadata", () => {
    const initial = fixture();
    const before = captureHistoricalImportFields(initial);
    const applied = {
      ...initial,
      currentTierId: "vip",
      lastQualifyingActivityAt: new Date("2026-09-09T00:00:00Z"),
      nextExpiryDate: new Date("2027-09-09T00:00:00Z"),
      pointsExpiryPolicyVersion: 3,
      metadata: {
        birthday: {
          birthDate: "2000-02-29",
          registeredAt: "2026-09-09T00:00:00Z",
        },
        unrelated: "initial",
      },
    };
    const after = captureHistoricalImportFields(applied);
    const patch = planHistoricalImportFieldRestoration({
      before,
      after,
      current: {
        ...applied,
        metadata: {
          ...applied.metadata,
          unrelated: "new value",
          anotherModule: { keep: true },
        },
      },
    });
    expect(patch).toEqual({
      metadata: { unrelated: "new value", anotherModule: { keep: true } },
      currentTierId: null,
      tierExpiresAt: null,
      lastQualifyingActivityAt: null,
      nextExpiryDate: null,
      pointsExpiryPolicyVersion: 0,
      pointsExpiryJobsScheduledAt: null,
    });
  });
  it("distinguishes absent birthday from an explicit null", () => {
    const original = fixture();
    original.metadata = { birthday: null };
    const before = captureHistoricalImportFields(original);
    const current = fixture();
    expect(
      planHistoricalImportFieldRestoration({
        before,
        after: captureHistoricalImportFields(current),
        current,
      }).metadata,
    ).toEqual({ unrelated: "initial", birthday: null });
    const empty = { ...fixture(), metadata: null };
    expect(
      planHistoricalImportFieldRestoration({
        before: captureHistoricalImportFields(empty),
        after: captureHistoricalImportFields(empty),
        current: empty,
      }).metadata,
    ).toBe(Prisma.DbNull);
  });
  it.each([
    "birthday",
    "tier",
    "tier_expiry",
    "activity",
    "expiry",
    "policy",
    "scheduled",
  ])("contains a later %s change", (kind) => {
    const initial = fixture();
    const before = captureHistoricalImportFields(initial);
    const current = fixture();
    if (kind === "birthday") current.metadata = { birthday: { changed: true } };
    if (kind === "tier") current.currentTierId = "new";
    if (kind === "tier_expiry") current.tierExpiresAt = new Date();
    if (kind === "activity") current.lastQualifyingActivityAt = new Date();
    if (kind === "expiry") current.nextExpiryDate = new Date();
    if (kind === "policy") current.pointsExpiryPolicyVersion = 1;
    if (kind === "scheduled") current.pointsExpiryJobsScheduledAt = new Date();
    expect(() =>
      planHistoricalImportFieldRestoration({ before, after: before, current }),
    ).toThrow("requires containment");
  });
  it.each(["storeId", "programId", "accountId"])(
    "rejects a foreign %s snapshot",
    (key) => {
      const current = fixture();
      const after = captureHistoricalImportFields(current);
      expect(() =>
        planHistoricalImportFieldRestoration({
          before: { ...after, [key]: "other" },
          after,
          current,
        }),
      ).toThrow("requires containment");
    },
  );
  it("compares birthday objects independently of JSON key ordering", () => {
    const initial = {
      ...fixture(),
      metadata: {
        birthday: {
          birthDate: "2000-01-01",
          registeredAt: "2026-01-01T00:00:00Z",
        },
      },
    };
    const before = captureHistoricalImportFields(initial);
    const current = {
      ...initial,
      metadata: {
        birthday: {
          registeredAt: "2026-01-01T00:00:00Z",
          birthDate: "2000-01-01",
        },
      },
    };
    expect(() =>
      planHistoricalImportFieldRestoration({ before, after: before, current }),
    ).not.toThrow();
  });
});

describe("import birthday planning", () => {
  const now = new Date("2026-09-09T00:00:00.000Z");
  it("uses the existing month/day anchor and schedules only a future eligible birthday", () => {
    const result = planHistoricalImportBirthday({
      metadata: { keep: true },
      birthday: { month: 9, day: 10 },
      now,
    });
    expect(result.metadata).toEqual({
      keep: true,
      birthday: {
        birthDate: "2000-09-10",
        registeredAt: now.toISOString(),
        nextEligibleYear: 2027,
      },
    });
    expect(result.schedule?.scheduledFor.toISOString()).toBe(
      "2027-09-10T00:00:00.000Z",
    );
  });
  it("preserves an existing registration and schedules nothing twice", () => {
    const metadata = {
      birthday: {
        birthDate: "2000-02-29",
        registeredAt: "2020-01-01T00:00:00Z",
        lastRewardedYear: 2026,
      },
      keep: true,
    };
    expect(
      planHistoricalImportBirthday({
        metadata,
        birthday: { month: 2, day: 29 },
        now,
      }),
    ).toEqual({ metadata, schedule: null });
  });
  it("rejects a conflicting birthday", () => {
    expect(() =>
      planHistoricalImportBirthday({
        metadata: {
          birthday: {
            birthDate: "2000-01-01",
            registeredAt: now.toISOString(),
          },
        },
        birthday: { month: 2, day: 29 },
        now,
      }),
    ).toThrow("conflicts");
  });
  it("does not alter birthday data when no birthday is imported", () => {
    const metadata = { birthday: { keep: "unchanged" } };
    expect(
      planHistoricalImportBirthday({ metadata, birthday: undefined, now }),
    ).toEqual({ metadata, schedule: null });
  });
});
