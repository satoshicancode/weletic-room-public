import {
  IMPORT_OPENING_BALANCE_REFERENCE,
  IMPORT_ROLLBACK_REFERENCE,
  postImportOpeningBalanceInTransaction,
  reverseImportOpeningBalanceInTransaction,
} from "@/lib/weletic/loyalty/historical-import-ledger";
import { getLifetimeEarnedPointsDelta } from "@/lib/weletic/loyalty/ledger-entry-policy";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: mocks.append,
}));
vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: (value: unknown) => Boolean(value),
}));

function fixture() {
  const account = {
    id: "account",
    storeId: "store",
    programId: "program",
    shopperId: "shopper",
    status: "active",
    metadata: null,
    ledgerVersion: 5,
    cachedPointsBalance: BigInt(10),
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([account]),
    weleticLoyaltyAccount: { findFirst: vi.fn().mockResolvedValue(account) },
  };
  const input = {
    tx: tx as unknown as Prisma.TransactionClient,
    storeId: "store",
    programId: "program",
    accountId: "account",
    shopperId: "shopper",
    sourceId: "source",
    snapshotId: "snapshot",
    normalizedSha256: "a".repeat(64),
    openingBalance: BigInt(20),
    expectedLedgerVersion: 5,
  };
  return { account, tx, input };
}
beforeEach(() => mocks.append.mockReset().mockResolvedValue({ id: "ledger" }));
describe("import opening balance ledger", () => {
  it("uses current locked eligibility instead of a stale consistent read", async () => {
    const f = fixture();
    f.tx.$queryRaw.mockResolvedValue([{ ...f.account, status: "closed" }]);
    // The ordinary read intentionally remains active at the same ledger version.
    await expect(
      postImportOpeningBalanceInTransaction(f.input),
    ).rejects.toThrow("account unavailable");
    expect(f.tx.weleticLoyaltyAccount.findFirst).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
  });
  it("uses a non-earn adjustment with immutable provenance and no pending points", async () => {
    const f = fixture();
    await postImportOpeningBalanceInTransaction(f.input);
    const call = mocks.append.mock.calls[0][0];
    expect(call).toMatchObject({
      entryType: "MANUAL_ADJUSTMENT",
      referenceType: IMPORT_OPENING_BALANCE_REFERENCE,
      pointsDelta: BigInt(20),
      pendingDelta: BigInt(0),
      metadata: {
        sourceId: "source",
        snapshotId: "snapshot",
        normalizedSha256: "a".repeat(64),
      },
    });
    expect(
      getLifetimeEarnedPointsDelta(
        call.entryType,
        call.pointsDelta,
        call.referenceType,
      ),
    ).toBe(BigInt(0));
    expect(call).not.toHaveProperty("grantId");
  });
  it("records zero opening balances without fabricating earns", async () => {
    const f = fixture();
    f.input.openingBalance = BigInt(0);
    await postImportOpeningBalanceInTransaction(f.input);
    expect(mocks.append.mock.calls[0][0].pointsDelta).toBe(BigInt(0));
  });
  it.each(["missing", "closed", "owner", "revision", "overflow"])(
    "rejects %s accounts before ledger writes",
    async (kind) => {
      const f = fixture();
      if (kind === "missing") f.tx.$queryRaw.mockResolvedValue([]);
      if (kind === "closed") f.account.status = "closed";
      if (kind === "owner") f.account.shopperId = "other";
      if (kind === "revision") f.account.ledgerVersion = 6;
      if (kind === "overflow")
        f.account.cachedPointsBalance = BigInt("9223372036854775807");
      await expect(
        postImportOpeningBalanceInTransaction(f.input),
      ).rejects.toThrow();
      expect(mocks.append).not.toHaveBeenCalled();
    },
  );
  it.each([BigInt(-1), BigInt("9223372036854775808")])(
    "rejects invalid balance case %#",
    async (openingBalance) => {
      const f = fixture();
      await expect(
        postImportOpeningBalanceInTransaction({ ...f.input, openingBalance }),
      ).rejects.toThrow();
      expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    },
  );
});

describe("import opening balance reversal", () => {
  function reversalFixture() {
    const f = fixture();
    const original = {
      id: "original",
      storeId: "store",
      accountId: "account",
      sequenceNumber: 5,
      entryType: "MANUAL_ADJUSTMENT",
      referenceType: IMPORT_OPENING_BALANCE_REFERENCE,
      referenceId: "snapshot",
      idempotencyKey: "loyalty_import_opening:source:snapshot",
      pointsDelta: BigInt(20),
      pendingDelta: BigInt(0),
      balanceAfter: BigInt(10),
      grantId: null,
      metadata: {
        sourceId: "source",
        snapshotId: "snapshot",
        normalizedSha256: "a".repeat(64),
      },
    };
    const tx = {
      ...f.tx,
      weleticPointsLedgerEntry: {
        findFirst: vi.fn().mockResolvedValue(original),
      },
    };
    const input = {
      ...f.input,
      tx: tx as unknown as Prisma.TransactionClient,
      originalLedgerEntryId: "original",
    };
    return { ...f, original, tx, input };
  }
  it("appends an exact correction without altering earned points", async () => {
    const f = reversalFixture();
    await reverseImportOpeningBalanceInTransaction(f.input);
    const call = mocks.append.mock.calls[0][0];
    expect(call).toMatchObject({
      entryType: "MANUAL_ADJUSTMENT",
      pointsDelta: BigInt(-20),
      referenceType: IMPORT_ROLLBACK_REFERENCE,
      metadata: { originalLedgerEntryId: "original" },
    });
    expect(
      getLifetimeEarnedPointsDelta(
        call.entryType,
        call.pointsDelta,
        call.referenceType,
      ),
    ).toBe(BigInt(0));
  });
  it.each([
    "later_activity",
    "changed_balance",
    "wrong_amount",
    "wrong_source",
    "wrong_type",
    "pending",
    "grant",
    "closed",
  ])("contains rollback for %s", async (kind) => {
    const f = reversalFixture();
    if (kind === "later_activity") f.account.ledgerVersion = 6;
    if (kind === "changed_balance") f.account.cachedPointsBalance = BigInt(11);
    if (kind === "wrong_amount") f.original.pointsDelta = BigInt(21);
    if (kind === "wrong_source") f.original.metadata.sourceId = "other";
    if (kind === "wrong_type") f.original.entryType = "EARN_ORDER";
    if (kind === "pending") f.original.pendingDelta = BigInt(1);
    if (kind === "grant") Object.assign(f.original, { grantId: "grant" });
    if (kind === "closed") f.account.status = "closed";
    await expect(
      reverseImportOpeningBalanceInTransaction(f.input),
    ).rejects.toThrow("requires containment");
    expect(mocks.append).not.toHaveBeenCalled();
  });
});
