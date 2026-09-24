import { beforeEach, expect, it, vi } from "vitest";
import { merchantRedemptionRowCsv } from "../../lib/weletic/loyalty/redemption-row-csv";
import {
  merchantRedemptionRowExportRequestSchema,
  verifyMerchantRedemptionRowExportResponse,
} from "../../lib/weletic/loyalty/redemption-row-export-contract";
import { readShopifyMerchantRedemptionRowExportInTransaction } from "../../lib/weletic/shopify/merchant-redemption-row-export";

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
const redemption = {
  id: "redemption-1",
  accountId: "random-account",
  createdAt: new Date("2026-09-02T00:00:00Z"),
  status: "used",
  artifactKind: "discount_code",
  pointsSpent: BigInt("9007199254740997"),
  usedAt: new Date("2026-10-02T00:00:00Z"),
  shopifyDiscountCode: '=HYPERLINK("https://private.example")',
  orderId: "order-secret",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(actor);
  mocks.query.mockResolvedValue([]);
});

it("requires a bounded UTC range and rejects a mismatched response generation", () => {
  expect(
    merchantRedemptionRowExportRequestSchema.safeParse(request).success,
  ).toBe(true);
  for (const invalid of [
    { ...request, filter: { ...request.filter, startAt: null } },
    {
      ...request,
      filter: { ...request.filter, endAt: "2027-10-01T00:00:00Z" },
    },
  ])
    expect(
      merchantRedemptionRowExportRequestSchema.safeParse(invalid).success,
    ).toBe(false);
  const response = {
    status: "available",
    coverage: "retained_nonredacted_points_redemptions_only",
    installationGeneration: "generation-1",
    filter: request.filter,
    rows: [],
  };
  expect(verifyMerchantRedemptionRowExportResponse(request, response)).toEqual(
    response,
  );
  expect(() =>
    verifyMerchantRedemptionRowExportResponse(request, {
      ...response,
      installationGeneration: "generation-2",
    }),
  ).toThrow();
});

it("rejects staff and stale installation before reading financial rows", async () => {
  mocks.authorize.mockResolvedValueOnce({ ...actor, owner: false });
  await expect(
    readShopifyMerchantRedemptionRowExportInTransaction(context),
  ).rejects.toThrow();
  mocks.authorize.mockResolvedValueOnce({
    ...actor,
    installationGeneration: "generation-2",
  });
  await expect(
    readShopifyMerchantRedemptionRowExportInTransaction(context),
  ).rejects.toThrow();
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.authorize).toHaveBeenCalledWith({
    tx: context.tx,
    envelope: context.envelope,
    permission: "analytics.export",
  });
});

it("exports exact decimal strings and pseudonyms without raw references", async () => {
  mocks.query.mockResolvedValue([redemption]);
  const result =
    await readShopifyMerchantRedemptionRowExportInTransaction(context);
  expect(result.status).toBe("available");
  expect(result.rows).toEqual([
    {
      accountPseudonym: expect.stringMatching(/^account_[a-f0-9]{32}$/),
      redemptionPseudonym: expect.stringMatching(/^redemption_[a-f0-9]{32}$/),
      createdAt: "2026-09-02T00:00:00.000Z",
      currentStatus: "used",
      artifactKind: "discount_code",
      pointsSpent: "9007199254740997",
      usedAt: "2026-10-02T00:00:00.000Z",
    },
  ]);
  expect(JSON.stringify(result)).not.toMatch(
    /random-account|redemption-1|order-secret|private.example|store-1/,
  );
});

it("returns no partial file when more than 2,000 rows match", async () => {
  mocks.query.mockResolvedValue(
    Array.from({ length: 2_001 }, () => redemption),
  );
  const result =
    await readShopifyMerchantRedemptionRowExportInTransaction(context);
  expect(result.status).toBe("too_large");
  expect(result.rows).toEqual([]);
  expect(mocks.query).toHaveBeenCalledTimes(1);
});

it("writes only fixed and validated CSV columns", () => {
  const csv = merchantRedemptionRowCsv([
    {
      accountPseudonym: `account_${"a".repeat(32)}`,
      redemptionPseudonym: `redemption_${"b".repeat(32)}`,
      createdAt: "2026-09-02T00:00:00.000Z",
      currentStatus: "used",
      artifactKind: "discount_code",
      pointsSpent: "9007199254740997",
      usedAt: "2026-10-02T00:00:00.000Z",
    },
  ]);
  expect(csv).toContain("used,discount_code,9007199254740997");
  expect(csv).not.toMatch(/order-secret|private.example/);
  expect(csv.endsWith("\r\n")).toBe(true);
  expect(() =>
    merchantRedemptionRowCsv([
      {
        accountPseudonym: `account_${"a".repeat(32)}`,
        redemptionPseudonym: `redemption_${"b".repeat(32)}`,
        createdAt: "2026-09-02T00:00:00.000Z",
        currentStatus: "used",
        artifactKind: "discount_code",
        pointsSpent: "=1+1",
        usedAt: null,
      },
    ]),
  ).toThrow("Invalid redemption integer");
});
