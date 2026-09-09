import { inspectHistoricalImportPreview } from "@/lib/weletic/loyalty/historical-import-preview";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/weletic/shopify/privacy-identity", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/shopify/privacy-identity")
  >()),
  deriveAllShopifyCustomerPrivacyIdentities: ({
    shopifyCustomerId,
  }: {
    shopifyCustomerId: string;
  }) => [
    {
      identityKind: "shopify_customer_id",
      identityKeyId: "key",
      customerDigest: shopifyCustomerId,
    },
  ],
}));
vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: (metadata: unknown) =>
    Boolean(metadata && typeof metadata === "object" && "redacted" in metadata),
}));

const request = {
  operation: "preview",
  expectedInstallationGeneration: "generation",
  expectedRevision: "a".repeat(64),
  source: { sha256: "b".repeat(64), format: "json" },
  rows: [
    { shopifyCustomerId: "gid://shopify/Customer/123", openingBalance: "10" },
  ],
};
function fixture(account: unknown = null) {
  return {
    weleticLoyaltyProgram: {
      findFirst: vi.fn().mockResolvedValue({ id: "program" }),
    },
    weleticLoyaltyTier: {
      findMany: vi.fn().mockResolvedValue([{ id: "tier" }]),
    },
    weleticShopper: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "shopper",
          shopifyCustomerId: "123",
          storeId: "store",
          email: "private@example.com",
          loyaltyAccount: account,
        },
      ]),
    },
    weleticShopifyCustomerPrivacyTombstone: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}
const account = {
  id: "account",
  shopperId: "shopper",
  storeId: "store",
  programId: "program",
  status: "active",
  metadata: null,
  cachedPointsBalance: BigInt(20),
};
const inspect = (tx: ReturnType<typeof fixture>, input: unknown = request) =>
  inspectHistoricalImportPreview({
    tx: tx as unknown as Prisma.TransactionClient,
    storeId: "store",
    programId: "program",
    request: input,
  });
describe("read-only historical import preview", () => {
  it("uses four bounded reads for a full 1000-row batch", async () => {
    const tx = fixture();
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      shopifyCustomerId: `gid://shopify/Customer/${index + 1}`,
      openingBalance: "1",
    }));
    tx.weleticShopper.findMany.mockResolvedValue(
      rows.map((row, index) => ({
        id: `shopper-${index}`,
        storeId: "store",
        shopifyCustomerId: row.shopifyCustomerId,
        email: null,
        loyaltyAccount: null,
      })),
    );
    expect((await inspect(tx, { ...request, rows })).valid).toBe(true);
    expect(tx.weleticLoyaltyProgram.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.weleticLoyaltyTier.findMany).toHaveBeenCalledTimes(1);
    expect(tx.weleticShopper.findMany).toHaveBeenCalledTimes(1);
    expect(
      tx.weleticShopifyCustomerPrivacyTombstone.findMany,
    ).toHaveBeenCalledTimes(1);
  });
  it("resolves numeric webhook IDs within the authenticated store", async () => {
    const tx = fixture(account);
    tx.weleticShopper.findMany.mockImplementation(async ({ where }) => {
      const stored = {
        id: "shopper",
        storeId: "store",
        shopifyCustomerId: "123",
        email: null,
        loyaltyAccount: account,
      };
      return where.storeId === stored.storeId &&
        where.shopifyCustomerId.in.includes(stored.shopifyCustomerId)
        ? [stored]
        : [];
    });
    expect((await inspect(tx)).valid).toBe(true);
    expect(tx.weleticShopper.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: "store",
          shopifyCustomerId: { in: ["gid://shopify/Customer/123", "123"] },
        },
      }),
    );
  });
  it("refuses ambiguous numeric/GID duplicate wallets", async () => {
    const tx = fixture(account);
    tx.weleticShopper.findMany.mockResolvedValue([
      {
        id: "one",
        shopifyCustomerId: "123",
        storeId: "store",
        loyaltyAccount: account,
      },
      {
        id: "two",
        shopifyCustomerId: "gid://shopify/Customer/123",
        storeId: "store",
        loyaltyAccount: null,
      },
    ]);
    expect((await inspect(tx)).rows[0].issues).toContain(
      "customer_unavailable",
    );
  });
  it("projects enrollment without creating an account or exposing identity", async () => {
    const result = await inspect(fixture());
    expect(result.rows[0]).toEqual({
      rowNumber: 1,
      issues: [],
      wouldEnroll: true,
      balanceBefore: "0",
      balanceAfter: "10",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private|shopper|Customer|account/,
    );
  });
  it("projects an additive opening balance without altering existing activity", async () => {
    expect((await inspect(fixture(account))).rows[0].balanceAfter).toBe("30");
  });
  it.each([
    {
      birthday: {
        birthDate: "2000-03-01",
        registeredAt: "2025-01-01T00:00:00.000Z",
      },
    },
    { birthday: { birthDate: "2000-02-29", registeredAt: "invalid" } },
    { birthday: "malformed" },
    ["malformed metadata"],
  ])(
    "rejects conflicting or malformed birthday state without exposing it: %j",
    async (metadata) => {
      const original = structuredClone(metadata);
      const result = await inspect(fixture({ ...account, metadata }), {
        ...request,
        rows: [{ ...request.rows[0], birthday: { month: 2, day: 29 } }],
      });
      expect(result).toEqual({
        valid: false,
        rows: [
          {
            rowNumber: 1,
            issues: ["birthday_conflict"],
            wouldEnroll: false,
            balanceBefore: null,
            balanceAfter: null,
          },
        ],
      });
      expect(metadata).toEqual(original);
      expect(JSON.stringify(result)).not.toMatch(
        /2000-|registeredAt|Customer|private/,
      );
    },
  );
  it.each([
    null,
    { birthday: null },
    {
      birthday: {
        birthDate: "2000-02-29",
        registeredAt: "2025-01-01T00:00:00.000Z",
        nextEligibleYear: 2028,
        lastAwardedYear: 2026,
      },
    },
  ])(
    "accepts a new or matching birthday without changing schedules: %j",
    async (metadata) => {
      const original = structuredClone(metadata);
      const result = await inspect(fixture({ ...account, metadata }), {
        ...request,
        rows: [{ ...request.rows[0], birthday: { month: 2, day: 29 } }],
      });
      expect(result.valid).toBe(true);
      expect(metadata).toEqual(original);
    },
  );
  it("does not reveal a birthday conflict for an unavailable account", async () => {
    const result = await inspect(
      fixture({
        ...account,
        storeId: "other",
        metadata: { birthday: "malformed" },
      }),
      {
        ...request,
        rows: [{ ...request.rows[0], birthday: { month: 2, day: 29 } }],
      },
    );
    expect(result.rows[0].issues).toEqual(["account_unavailable"]);
  });
  it("does not validate or alter a birthday omitted from the source", async () => {
    expect(
      (
        await inspect(
          fixture({ ...account, metadata: { birthday: "unchanged" } }),
        )
      ).valid,
    ).toBe(true);
  });
  it("fails closed for a cross-store program", async () => {
    const tx = fixture();
    tx.weleticLoyaltyProgram.findFirst.mockResolvedValue(null);
    await expect(inspect(tx)).rejects.toThrow("program unavailable");
    expect(tx.weleticShopper.findMany).not.toHaveBeenCalled();
  });
  it.each([
    { storeId: "other" },
    { programId: "other" },
    { status: "closed" },
    { shopperId: "other" },
    { metadata: { redacted: true } },
  ])("rejects unavailable account %j", async (change) => {
    const result = await inspect(fixture({ ...account, ...change }));
    expect(result.valid).toBe(false);
    expect(result.rows[0].balanceAfter).toBeNull();
  });
  it("rejects a privacy identity tombstone", async () => {
    const tx = fixture(account);
    tx.weleticShopifyCustomerPrivacyTombstone.findMany.mockResolvedValue([
      {
        identityKind: "shopify_customer_id",
        identityKeyId: "key",
        customerDigest: request.rows[0].shopifyCustomerId,
        expiresAt: new Date("2099-01-01"),
        shopperId: null,
        accountId: null,
      },
    ]);
    expect((await inspect(tx)).rows[0].issues).toContain(
      "customer_unavailable",
    );
  });
  it("rejects a retained owner tombstone", async () => {
    const tx = fixture(account);
    tx.weleticShopifyCustomerPrivacyTombstone.findMany.mockResolvedValue([
      {
        shopperId: "shopper",
        accountId: "account",
        identityKind: "shopify_customer_id",
        identityKeyId: "key",
        customerDigest: "old",
        expiresAt: new Date("2000-01-01"),
      },
    ]);
    expect((await inspect(tx)).valid).toBe(false);
  });
  it("rejects unresolved customers", async () => {
    const tx = fixture();
    tx.weleticShopper.findMany.mockResolvedValue([]);
    expect((await inspect(tx)).rows[0].wouldEnroll).toBe(false);
  });
  it("rejects deleted or other-program tiers", async () => {
    expect(
      (
        await inspect(fixture(), {
          ...request,
          rows: [{ ...request.rows[0], tierId: "other" }],
        })
      ).rows[0].issues,
    ).toContain("tier_unavailable");
  });
  it("rejects resulting balance overflow", async () => {
    expect(
      (
        await inspect(
          fixture({
            ...account,
            cachedPointsBalance: BigInt("9223372036854775807"),
          }),
        )
      ).rows[0].issues,
    ).toContain("balance_overflow");
  });
});
