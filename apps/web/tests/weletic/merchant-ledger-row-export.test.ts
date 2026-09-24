import { beforeEach, expect, it, vi } from "vitest";
import { merchantLedgerRowCsv } from "../../lib/weletic/loyalty/ledger-row-csv";
import {
  merchantLedgerRowExportRequestSchema,
  verifyMerchantLedgerRowExportResponse,
} from "../../lib/weletic/loyalty/ledger-row-export-contract";
import { readShopifyMerchantLedgerRowExportInTransaction } from "../../lib/weletic/shopify/merchant-ledger-row-export";

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
const ledger = {
  id: "entry-1",
  accountId: "random-account",
  sequenceNumber: 3,
  createdAt: new Date("2026-09-02T00:00:00Z"),
  entryType: "BACKFILL_CORRECTION",
  pointsDelta: BigInt("-5"),
  pendingDelta: BigInt("0"),
  balanceAfter: BigInt("9007199254740997"),
  reason: '=HYPERLINK("https://private.example")',
  referenceId: "order-secret",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(actor);
  mocks.query.mockResolvedValue([]);
});

it("requires a bounded UTC range and rejects a mismatched response generation", () => {
  expect(merchantLedgerRowExportRequestSchema.safeParse(request).success).toBe(
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
      merchantLedgerRowExportRequestSchema.safeParse(invalid).success,
    ).toBe(false);
  const response = {
    status: "available",
    coverage: "retained_nonredacted_ledger_entries_only",
    installationGeneration: "generation-1",
    filter: request.filter,
    rows: [],
  };
  expect(verifyMerchantLedgerRowExportResponse(request, response)).toEqual(
    response,
  );
  expect(() =>
    verifyMerchantLedgerRowExportResponse(request, {
      ...response,
      installationGeneration: "generation-2",
    }),
  ).toThrow();
});

it("rejects staff and stale installation before reading financial rows", async () => {
  mocks.authorize.mockResolvedValueOnce({ ...actor, owner: false });
  await expect(
    readShopifyMerchantLedgerRowExportInTransaction(context),
  ).rejects.toThrow();
  mocks.authorize.mockResolvedValueOnce({
    ...actor,
    installationGeneration: "generation-2",
  });
  await expect(
    readShopifyMerchantLedgerRowExportInTransaction(context),
  ).rejects.toThrow();
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.authorize).toHaveBeenCalledWith({
    tx: context.tx,
    envelope: context.envelope,
    permission: "analytics.export",
  });
});

it("exports exact decimal strings and pseudonyms without raw references", async () => {
  mocks.query.mockResolvedValue([ledger]);
  const result = await readShopifyMerchantLedgerRowExportInTransaction(context);
  expect(result.status).toBe("available");
  expect(result.rows).toEqual([
    {
      accountPseudonym: expect.stringMatching(/^account_[a-f0-9]{32}$/),
      sequenceNumber: 3,
      createdAt: "2026-09-02T00:00:00.000Z",
      entryType: "BACKFILL_CORRECTION",
      pointsDelta: "-5",
      pendingDelta: "0",
      balanceAfter: "9007199254740997",
    },
  ]);
  expect(JSON.stringify(result)).not.toMatch(
    /random-account|entry-1|order-secret|private.example|store-1/,
  );
});

it("returns no partial file when more than 2,000 rows match", async () => {
  mocks.query.mockResolvedValue(Array.from({ length: 2_001 }, () => ledger));
  const result = await readShopifyMerchantLedgerRowExportInTransaction(context);
  expect(result.status).toBe("too_large");
  expect(result.rows).toEqual([]);
  expect(mocks.query).toHaveBeenCalledTimes(1);
});

it("writes only fixed and validated CSV columns", () => {
  const csv = merchantLedgerRowCsv([
    {
      accountPseudonym: `account_${"a".repeat(32)}`,
      sequenceNumber: 1,
      createdAt: "2026-09-02T00:00:00.000Z",
      entryType: "BACKFILL_CORRECTION",
      pointsDelta: "-5",
      pendingDelta: "0",
      balanceAfter: "9007199254740997",
    },
  ]);
  expect(csv).toContain("BACKFILL_CORRECTION,-5,0,9007199254740997");
  expect(csv).not.toMatch(/order-secret|private.example/);
  expect(csv.endsWith("\r\n")).toBe(true);
  expect(() =>
    merchantLedgerRowCsv([
      {
        accountPseudonym: `account_${"a".repeat(32)}`,
        sequenceNumber: 1,
        createdAt: "2026-09-02T00:00:00.000Z",
        entryType: "BACKFILL_CORRECTION",
        pointsDelta: "=1+1",
        pendingDelta: "0",
        balanceAfter: "0",
      },
    ]),
  ).toThrow("Invalid ledger integer");
});
