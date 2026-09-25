import { beforeEach, expect, it, vi } from "vitest";
import { merchantAccountRowCsv } from "../../lib/weletic/loyalty/account-row-csv";
import {
  merchantAccountRowExportRequestSchema,
  verifyMerchantAccountRowExportResponse,
} from "../../lib/weletic/loyalty/account-row-export-contract";
import { readShopifyMerchantAccountRowExportInTransaction } from "../../lib/weletic/shopify/merchant-account-row-export";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), query: vi.fn() }));
vi.mock("../../lib/weletic/shopify/staff-authorization", async (original) => ({
  ...(await original<
    typeof import("../../lib/weletic/shopify/staff-authorization")
  >()),
  authorizeShopifyMerchantInTransaction: mocks.authorize,
}));

const request = {
  filter: {
    startAt: "2026-09-01T00:00:00.000Z",
    endAt: "2026-09-30T23:59:59.999Z",
  },
  expectedInstallationGeneration: "generation-1",
};
const actor = {
  owner: true,
  storeId: "store-1",
  installationGeneration: "generation-1",
};
const context = {
  tx: { $queryRaw: mocks.query } as never,
  envelope: { signed: true },
  request,
};
const account = {
  id: "private-account-id",
  enrolledAt: new Date("2026-09-02T00:00:00.000Z"),
  status: "active",
  tierOrder: 2,
  cachedPointsBalance: BigInt("9007199254740997"),
  cachedPendingPoints: BigInt("5"),
  lifetimePointsEarned: BigInt("9007199254740999"),
  lifetimePointsRedeemed: BigInt("2"),
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(actor);
  mocks.query.mockResolvedValue([]);
});

it("requires a bounded UTC range and exact response generation", () => {
  expect(merchantAccountRowExportRequestSchema.safeParse(request).success).toBe(
    true,
  );
  for (const invalid of [
    { ...request, filter: { ...request.filter, startAt: null } },
    {
      ...request,
      filter: { ...request.filter, endAt: "2027-10-01T00:00:00Z" },
    },
  ])
    expect(
      merchantAccountRowExportRequestSchema.safeParse(invalid).success,
    ).toBe(false);
  const response = {
    status: "available",
    coverage: "current_retained_nonredacted_accounts_by_enrollment",
    installationGeneration: "generation-1",
    filter: request.filter,
    rows: [],
  };
  expect(verifyMerchantAccountRowExportResponse(request, response)).toEqual(
    response,
  );
  expect(() =>
    verifyMerchantAccountRowExportResponse(request, {
      ...response,
      installationGeneration: "generation-2",
    }),
  ).toThrow();
});

it("rejects staff and stale installation before reading accounts", async () => {
  mocks.authorize.mockResolvedValueOnce({ ...actor, owner: false });
  await expect(
    readShopifyMerchantAccountRowExportInTransaction(context),
  ).rejects.toThrow();
  mocks.authorize.mockResolvedValueOnce({
    ...actor,
    installationGeneration: "generation-2",
  });
  await expect(
    readShopifyMerchantAccountRowExportInTransaction(context),
  ).rejects.toThrow();
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.authorize).toHaveBeenCalledWith({
    tx: context.tx,
    envelope: context.envelope,
    permission: "analytics.export",
  });
});

it("rechecks selected accounts and returns only pseudonyms and exact strings", async () => {
  mocks.query.mockResolvedValueOnce([{ id: account.id }]);
  mocks.query.mockResolvedValueOnce([{ id: account.id }]);
  mocks.query.mockResolvedValueOnce([account]);
  const result =
    await readShopifyMerchantAccountRowExportInTransaction(context);
  expect(mocks.query).toHaveBeenCalledTimes(3);
  expect(result.rows).toEqual([
    {
      accountPseudonym: expect.stringMatching(/^account_[a-f0-9]{32}$/),
      enrolledAt: "2026-09-02T00:00:00.000Z",
      accountStatus: "active",
      currentTierOrder: 2,
      cachedPointsBalance: "9007199254740997",
      cachedPendingPoints: "5",
      lifetimePointsEarned: "9007199254740999",
      lifetimePointsRedeemed: "2",
    },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/private-account-id|store-1/);
  mocks.query.mockResolvedValueOnce([{ id: account.id }]);
  mocks.query.mockResolvedValueOnce([{ id: account.id }]);
  mocks.query.mockResolvedValueOnce([]);
  expect(
    (await readShopifyMerchantAccountRowExportInTransaction(context)).rows,
  ).toEqual([]);
});

it("returns no partial file when more than 2,000 rows match", async () => {
  mocks.query.mockResolvedValueOnce(
    Array.from({ length: 2_001 }, (_, i) => ({ id: `account-${i}` })),
  );
  const result =
    await readShopifyMerchantAccountRowExportInTransaction(context);
  expect(result.status).toBe("too_large");
  expect(result.rows).toEqual([]);
  expect(mocks.query).toHaveBeenCalledTimes(1);
});

it("writes fixed validated CSV columns and rejects formula payloads", () => {
  const row = {
    accountPseudonym: `account_${"a".repeat(32)}`,
    enrolledAt: "2026-09-02T00:00:00.000Z",
    accountStatus: "active" as const,
    currentTierOrder: 2,
    cachedPointsBalance: "9007199254740997",
    cachedPendingPoints: "5",
    lifetimePointsEarned: "9007199254740999",
    lifetimePointsRedeemed: "2",
  };
  const csv = merchantAccountRowCsv([row]);
  expect(csv).toContain("active,2,9007199254740997,5,9007199254740999,2");
  expect(csv.endsWith("\r\n")).toBe(true);
  expect(() =>
    merchantAccountRowCsv([{ ...row, cachedPointsBalance: "=1+1" }]),
  ).toThrow();
});
