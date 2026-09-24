import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { readMerchantRedemptionSources } from "../../lib/weletic/loyalty/redemption-sources";

const raw = vi.fn();
const tx = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
const startAt = new Date("2026-09-01T12:00:00.000Z");
const endAt = new Date("2026-09-30T10:00:00.000Z");
const read = (start: Date | null = startAt, end: Date | null = endAt) =>
  readMerchantRedemptionSources({
    tx,
    storeId: "store-a",
    startAt: start,
    endAt: end,
  });

beforeEach(() => raw.mockReset());

it("ranks corroborated debit-time reward metadata and reconciles unknown rows", async () => {
  raw
    .mockResolvedValueOnce([
      {
        eventCount: "3",
        pointsSpent: "9007199254741044",
        knownCount: "2",
        knownPoints: "9007199254740994",
      },
    ])
    .mockResolvedValueOnce([
      {
        rewardDefinitionId: "reward-one",
        capturedName: "=Voucher",
        rewardType: "amount_off",
        eventCount: "2",
        pointsSpent: "9007199254740994",
      },
    ]);
  expect(await read()).toEqual({
    coverage: "retained_redemption_debits_only",
    rows: [
      {
        rewardDefinitionId: "reward-one",
        capturedName: "=Voucher",
        rewardType: "amount_off",
        eventCount: "2",
        pointsSpent: "9007199254740994",
      },
    ],
    other: { eventCount: "0", pointsSpent: "0" },
    unknown: { eventCount: "1", pointsSpent: "50" },
    total: { eventCount: "3", pointsSpent: "9007199254741044" },
  });
  for (const [query] of raw.mock.calls as [Prisma.Sql][]) {
    expect(query.values).toContain("store-a");
    expect(query.values).toContain(startAt);
    expect(query.values).toContain(endAt);
    expect(query.sql).toContain("l.entryType = 'REDEEM_REWARD'");
    expect(query.sql).toContain("r.ledgerEntryId = l.id");
    expect(query.sql).toContain("l.pointsDelta < 0");
  }
});

it("bounds the ranking at ten and aggregates other captured rewards", async () => {
  raw
    .mockResolvedValueOnce([
      {
        eventCount: "11",
        pointsSpent: "110",
        knownCount: "11",
        knownPoints: "110",
      },
    ])
    .mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, index) => ({
        rewardDefinitionId: `reward-${index}`,
        capturedName: `Reward ${index}`,
        rewardType: "amount_off",
        eventCount: "1",
        pointsSpent: "10",
      })),
    );
  const result = await read(null, null);
  expect(result.other).toEqual({ eventCount: "1", pointsSpent: "10" });
  expect(result.unknown).toEqual({ eventCount: "0", pointsSpent: "0" });
  expect((raw.mock.calls[0][0] as Prisma.Sql).values).toContain("store-a");
  expect((raw.mock.calls[1][0] as Prisma.Sql).sql).toContain("LIMIT 10");
});

it("rejects inconsistent summary, duplicate groups and impossible totals", async () => {
  for (const summary of [
    { eventCount: "1", pointsSpent: "0", knownCount: "0", knownPoints: "0" },
    { eventCount: "1", pointsSpent: "10", knownCount: "2", knownPoints: "20" },
  ]) {
    raw.mockReset().mockResolvedValueOnce([summary]).mockResolvedValueOnce([]);
    await expect(read()).rejects.toThrow();
  }
  const row = {
    rewardDefinitionId: "reward-one",
    capturedName: "Voucher",
    rewardType: "amount_off",
    eventCount: "1",
    pointsSpent: "10",
  };
  raw
    .mockReset()
    .mockResolvedValueOnce([
      {
        eventCount: "2",
        pointsSpent: "20",
        knownCount: "2",
        knownPoints: "20",
      },
    ])
    .mockResolvedValueOnce([row, row]);
  await expect(read()).rejects.toThrow();
});
