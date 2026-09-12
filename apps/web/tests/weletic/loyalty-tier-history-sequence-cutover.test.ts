import { describe, expect, it, vi } from "vitest";
import { planTierHistorySequences } from "../../scripts/loyalty/backfill-earn-policy-revisions";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

function history({
  id,
  accountId = "account_sequence",
  effectiveAt,
  sequenceNumber = null,
}: {
  id: string;
  accountId?: string;
  effectiveAt: string;
  sequenceNumber?: number | null;
}) {
  return {
    id,
    accountId,
    effectiveAt: new Date(effectiveAt),
    sequenceNumber,
    toTierId: `tier_${id}`,
  };
}

describe("earn-policy cutover tier-history sequencing", () => {
  it("preserves an authoritative no-tier destination in sequence planning", () => {
    const row = {
      ...history({
        id: "history_restore",
        effectiveAt: "2026-09-09T00:00:00.000Z",
        sequenceNumber: 1,
      }),
      toTierId: null,
    };
    const plan = planTierHistorySequences([row]);
    expect(plan.blockers).toEqual([]);
    expect(plan.assignments).toEqual([]);
    expect(
      plan.orderedHistoriesByAccount.get("account_sequence")?.[0].toTierId,
    ).toBeNull();
  });
  it("assigns contiguous sequences by event time and exposes the next marker sequence", () => {
    const plan = planTierHistorySequences([
      history({
        id: "history_later",
        effectiveAt: "2026-02-01T00:00:00.000Z",
      }),
      history({
        id: "history_earlier",
        effectiveAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    expect(plan.blockers).toEqual([]);
    expect(plan.assignments).toEqual([
      expect.objectContaining({
        historyId: "history_earlier",
        sequenceNumber: 1,
      }),
      expect.objectContaining({
        historyId: "history_later",
        sequenceNumber: 2,
      }),
    ]);
    expect(plan.nextSequenceNumberByAccount.get("account_sequence")).toBe(3);
  });

  it("blocks timestamp ties whose historical ordering cannot be reconstructed", () => {
    const plan = planTierHistorySequences([
      history({
        id: "history_tie_a",
        effectiveAt: "2026-01-01T00:00:00.000Z",
      }),
      history({
        id: "history_tie_b",
        effectiveAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    expect(plan.assignments).toEqual([]);
    expect(plan.blockedAccountIds).toContain("account_sequence");
    expect(plan.blockers.join(" ")).toMatch(/cannot be reconstructed/i);
  });

  it("accepts an already sequenced timestamp tie and preserves its order", () => {
    const plan = planTierHistorySequences([
      history({
        id: "history_tie_second",
        effectiveAt: "2026-01-01T00:00:00.000Z",
        sequenceNumber: 2,
      }),
      history({
        id: "history_tie_first",
        effectiveAt: "2026-01-01T00:00:00.000Z",
        sequenceNumber: 1,
      }),
    ]);

    expect(plan.blockers).toEqual([]);
    expect(plan.assignments).toEqual([]);
    expect(
      plan.orderedHistoriesByAccount
        .get("account_sequence")
        ?.map(({ id }) => id),
    ).toEqual(["history_tie_first", "history_tie_second"]);
    expect(plan.nextSequenceNumberByAccount.get("account_sequence")).toBe(3);
  });

  it("blocks non-contiguous pre-existing sequences instead of renumbering them", () => {
    const plan = planTierHistorySequences([
      history({
        id: "history_one",
        effectiveAt: "2026-01-01T00:00:00.000Z",
        sequenceNumber: 1,
      }),
      history({
        id: "history_three",
        effectiveAt: "2026-02-01T00:00:00.000Z",
        sequenceNumber: 3,
      }),
    ]);

    expect(plan.assignments).toEqual([]);
    expect(plan.blockers.join(" ")).toMatch(/expected contiguous sequence 2/i);
  });
});
