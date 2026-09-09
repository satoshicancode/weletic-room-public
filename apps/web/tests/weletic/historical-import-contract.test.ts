import {
  historicalImportPreviewRequestSchema,
  historicalImportRowSchema,
} from "@/lib/weletic/loyalty/historical-import-contract";
import { describe, expect, it } from "vitest";

const row = {
  shopifyCustomerId: "gid://shopify/Customer/123",
  openingBalance: "9007199254740993",
};
const request = {
  operation: "preview",
  expectedInstallationGeneration: "installation-1",
  expectedRevision: "a".repeat(64),
  source: { sha256: "b".repeat(64), format: "csv" },
  rows: [row],
};

describe("historical import contracts", () => {
  it("preserves balances larger than Number.MAX_SAFE_INTEGER exactly", () => {
    expect(historicalImportRowSchema.parse(row).openingBalance).toBe(
      row.openingBalance,
    );
  });
  it.each(["-1", "01", "1.5", "1e3", " 1", "9223372036854775808", 1])(
    "rejects noncanonical or overflowing balance %s",
    (openingBalance) => {
      expect(
        historicalImportRowSchema.safeParse({ ...row, openingBalance }).success,
      ).toBe(false);
    },
  );
  it.each(["0", "9223372036854775807"])(
    "accepts boundary %s",
    (openingBalance) => {
      expect(
        historicalImportRowSchema.safeParse({ ...row, openingBalance }).success,
      ).toBe(true);
    },
  );
  it("accepts leap-day birthdays without collecting birth year", () => {
    expect(
      historicalImportRowSchema.safeParse({
        ...row,
        birthday: { month: 2, day: 29 },
      }).success,
    ).toBe(true);
  });
  it.each([
    { month: 2, day: 30 },
    { month: 4, day: 31 },
    { month: 0, day: 1 },
    { month: 1, day: 0 },
  ])("rejects impossible birthday %j", (birthday) => {
    expect(
      historicalImportRowSchema.safeParse({ ...row, birthday }).success,
    ).toBe(false);
  });
  it.each([
    "123",
    "gid://shopify/Order/123",
    "gid://shopify/Customer/0123",
    "someone@example.com",
  ])("rejects ambiguous customer identity %s", (shopifyCustomerId) => {
    expect(
      historicalImportRowSchema.safeParse({ ...row, shopifyCustomerId })
        .success,
    ).toBe(false);
  });
  it("accepts a fenced preview with source provenance", () => {
    expect(historicalImportPreviewRequestSchema.parse(request).rows).toEqual([
      row,
    ]);
  });
  it("rejects duplicate customers instead of silently combining balances", () => {
    expect(
      historicalImportPreviewRequestSchema.safeParse({
        ...request,
        rows: [row, row],
      }).success,
    ).toBe(false);
  });
  it("rejects empty and oversized batches", () => {
    for (const rows of [
      [],
      Array.from({ length: 1001 }, (_, index) => ({
        ...row,
        shopifyCustomerId: `gid://shopify/Customer/${index + 1}`,
      })),
    ]) {
      expect(
        historicalImportPreviewRequestSchema.safeParse({ ...request, rows })
          .success,
      ).toBe(false);
    }
  });
  it("rejects tenant injection and fabricated historical rewards", () => {
    expect(
      historicalImportPreviewRequestSchema.safeParse({
        ...request,
        storeId: "other-store",
      }).success,
    ).toBe(false);
    expect(
      historicalImportRowSchema.safeParse({
        ...row,
        lifetimeEarned: "100",
        coupons: [],
      }).success,
    ).toBe(false);
  });
  it("requires both revision and installation fences", () => {
    for (const key of [
      "expectedRevision",
      "expectedInstallationGeneration",
    ] as const) {
      expect(
        historicalImportPreviewRequestSchema.safeParse({
          ...request,
          [key]: undefined,
        }).success,
      ).toBe(false);
    }
  });
});
