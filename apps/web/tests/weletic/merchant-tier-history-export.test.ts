import { beforeEach, expect, it, vi } from "vitest";
import { merchantTierHistoryCsv } from "../../lib/weletic/loyalty/tier-history-csv";
import {
  merchantTierHistoryExportRequestSchema,
  verifyMerchantTierHistoryExportResponse,
} from "../../lib/weletic/loyalty/tier-history-export-contract";
import { readShopifyMerchantTierHistoryExportInTransaction } from "../../lib/weletic/shopify/merchant-tier-history-export";

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

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(actor);
  mocks.query.mockResolvedValue([]);
});

it("requires a bounded UTC range and validates generation", () => {
  expect(
    merchantTierHistoryExportRequestSchema.safeParse(request).success,
  ).toBe(true);
  for (const invalid of [
    { ...request, filter: { ...request.filter, startAt: null } },
    {
      ...request,
      filter: { ...request.filter, endAt: "2027-10-01T00:00:00Z" },
    },
  ])
    expect(
      merchantTierHistoryExportRequestSchema.safeParse(invalid).success,
    ).toBe(false);
  const response = {
    status: "available",
    coverage: "retained_nonredacted_tier_events_only",
    installationGeneration: "generation-1",
    filter: request.filter,
    rows: [],
  };
  expect(verifyMerchantTierHistoryExportResponse(request, response)).toEqual(
    response,
  );
  expect(() =>
    verifyMerchantTierHistoryExportResponse(request, {
      ...response,
      installationGeneration: "stale-generation",
    }),
  ).toThrow();
  expect(() =>
    verifyMerchantTierHistoryExportResponse(request, {
      ...response,
      status: "too_large",
      rows: [{ accountPseudonym: `account_${"a".repeat(32)}` }],
    }),
  ).toThrow();
});

it("authorizes an owner export before reading rows and rejects stale installation", async () => {
  mocks.authorize.mockResolvedValueOnce({ ...actor, owner: false });
  await expect(
    readShopifyMerchantTierHistoryExportInTransaction(context),
  ).rejects.toThrow();
  expect(mocks.query).not.toHaveBeenCalled();
  mocks.authorize.mockResolvedValueOnce({
    ...actor,
    installationGeneration: "generation-2",
  });
  await expect(
    readShopifyMerchantTierHistoryExportInTransaction(context),
  ).rejects.toThrow();
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.authorize).toHaveBeenCalledWith({
    tx: context.tx,
    envelope: context.envelope,
    permission: "analytics.export",
  });
});

it("pseudonymizes distinct retained accounts and omits notes and raw IDs", async () => {
  mocks.query.mockResolvedValue([
    {
      id: "history-1",
      accountId: "random-account-1",
      effectiveAt: new Date("2026-09-02T00:00:00Z"),
      fromTierCurrentName: "Silver",
      toTierCurrentName: "Gold",
      changeReason: "threshold_reached",
      notes: "private note that must never leave the service",
    },
    {
      id: "history-2",
      accountId: "random-account-2",
      effectiveAt: new Date("2026-09-03T00:00:00Z"),
      fromTierCurrentName: null,
      toTierCurrentName: "Gold",
      changeReason: "manual_override",
    },
  ]);
  const result =
    await readShopifyMerchantTierHistoryExportInTransaction(context);
  expect(result.rows).toHaveLength(2);
  expect(result.rows[0].accountPseudonym).toMatch(/^account_[a-f0-9]{32}$/);
  expect(result.rows[0].accountPseudonym).not.toBe(
    result.rows[1].accountPseudonym,
  );
  expect(JSON.stringify(result)).not.toMatch(
    /random-account|history-1|private note|store-1/,
  );
  expect(result.status).toBe("available");
});

it("returns no row data when the export exceeds its bound", async () => {
  const row = {
    id: "history",
    accountId: "random-account",
    effectiveAt: new Date("2026-09-02T00:00:00Z"),
    fromTierCurrentName: null,
    toTierCurrentName: "Gold",
    changeReason: "threshold_reached",
  };
  mocks.query.mockResolvedValue(Array.from({ length: 2_001 }, () => row));
  const result =
    await readShopifyMerchantTierHistoryExportInTransaction(context);
  expect(result.status).toBe("too_large");
  expect(result.rows).toEqual([]);
});

it("quotes merchant-controlled labels and neutralizes spreadsheet formulas", () => {
  const csv = merchantTierHistoryCsv([
    {
      accountPseudonym: `account_${"a".repeat(32)}`,
      effectiveAt: "2026-09-02T00:00:00Z",
      fromTierCurrentName: '=HYPERLINK("https://example.com")',
      toTierCurrentName: 'Gold, "elite"\nVIP',
      changeReason: "threshold_reached",
    },
  ]);
  expect(csv).toContain(`"'=HYPERLINK(""https://example.com"")"`);
  expect(csv).toContain('"Gold, ""elite""\nVIP"');
  expect(csv.endsWith("\r\n")).toBe(true);
});
