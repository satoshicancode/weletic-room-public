import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { enqueueVipAchievementCommunication } from "../../lib/weletic/loyalty/vip-achievement-communication-producer";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../../lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: enqueue,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const template = {
  subject: "Welcome to {{tier_name}}",
  heading: "VIP",
  body: "Your new tier",
  actionLabel: "View",
};
const program = vi.fn();
const account = vi.fn();
const history = vi.fn();
const tiers = vi.fn();
const store = vi.fn();
const tx = {
  weleticLoyaltyProgram: { findUnique: program },
  weleticLoyaltyAccount: { findFirst: account },
  weleticLoyaltyTierHistory: { findFirst: history },
  weleticLoyaltyTier: { findMany: tiers },
  weleticShopifyStore: { findUnique: store },
} as unknown as Prisma.TransactionClient;
const programRow = () => ({
  id: "program",
  storeId: "store",
  status: "active",
  killSwitchActive: false,
  metadata: {
    loyaltyCommunications: {
      version: 1,
      sequence: 1,
      policies: [
        {
          journey: "vip_achieved",
          enabled: true,
          templates: { en: template, ja: template, vi: template },
        },
      ],
    },
  },
});
const input = () => ({
  tx,
  storeId: "store",
  programId: "program",
  accountId: "account",
  expectedInstallationGeneration: "g1",
  receipt: {
    created: true,
    history: {
      id: "history",
      accountId: "account",
      sequenceNumber: 1,
      fromTierId: "bronze",
      toTierId: "gold",
      changeReason: "threshold_reached",
      effectiveAt: new Date("2026-09-10T00:00:00Z"),
    },
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  program.mockResolvedValue(programRow());
  account.mockResolvedValue({ id: "account", currentTierId: "gold" });
  history.mockResolvedValue(input().receipt.history);
  tiers.mockResolvedValue([
    { id: "bronze", programId: "program", tierOrder: 1, name: "Bronze" },
    { id: "gold", programId: "program", tierOrder: 3, name: "Gold" },
  ]);
  store.mockResolvedValue({
    installationGeneration: "g1",
    storeAccessState: "active",
    complianceState: "active",
  });
  enqueue.mockResolvedValue({ created: true });
});
it("enqueues owned immutable history using the caller transaction", async () => {
  await enqueueVipAchievementCommunication(input());
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      tx,
      storeId: "store",
      jobType: "LOYALTY_COMMUNICATION",
      payload: expect.objectContaining({
        journey: "vip_achieved",
        tierHistoryId: "history",
        sequenceNumber: 1,
        toTier: { id: "gold", rank: 3, name: "Gold" },
      }),
    }),
  );
  expect(tiers).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        programId: "program",
        program: { storeId: "store" },
        id: { in: ["bronze", "gold"] },
        deletedAt: null,
      },
    }),
  );
});
it("does not read policy or enqueue replayed history", async () => {
  const data = input();
  data.receipt.created = false;
  expect(await enqueueVipAchievementCommunication(data)).toBeNull();
  expect(program).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});
it.each(["absent", "disabled", "paused", "inactive"])(
  "skips %s policy/program",
  async (kind) => {
    const row = programRow();
    if (kind === "absent") row.metadata.loyaltyCommunications.policies = [];
    if (kind === "disabled")
      row.metadata.loyaltyCommunications.policies[0].enabled = false;
    if (kind === "paused") row.killSwitchActive = true;
    if (kind === "inactive") row.status = "paused";
    program.mockResolvedValue(row);
    expect(await enqueueVipAchievementCommunication(input())).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  },
);
it.each(["program", "account", "history", "tier", "generation", "approval"])(
  "rejects missing or mismatched %s",
  async (kind) => {
    if (kind === "program")
      program.mockResolvedValue({ ...programRow(), id: "foreign" });
    if (kind === "account") account.mockResolvedValue(null);
    if (kind === "history")
      history.mockResolvedValue({
        ...input().receipt.history,
        id: "newer",
        sequenceNumber: 2,
      });
    if (kind === "tier") tiers.mockResolvedValue([]);
    if (kind === "generation")
      store.mockResolvedValue({
        installationGeneration: "g2",
        storeAccessState: "active",
        complianceState: "active",
      });
    if (kind === "approval")
      store.mockResolvedValue({
        installationGeneration: "g1",
        storeAccessState: "pending_approval",
        complianceState: "active",
      });
    await expect(enqueueVipAchievementCommunication(input())).rejects.toThrow(
      "unavailable",
    );
    expect(enqueue).not.toHaveBeenCalled();
  },
);
it.each(["annual_downgrade", "manual", "import"])(
  "rejects %s placement",
  async (reason) => {
    const data = input();
    data.receipt.history.changeReason = reason;
    await expect(enqueueVipAchievementCommunication(data)).rejects.toThrow(
      "source unavailable",
    );
    expect(enqueue).not.toHaveBeenCalled();
  },
);
it("rejects superseded account tier even when history matches", async () => {
  account.mockResolvedValue({ id: "account", currentTierId: "bronze" });
  await expect(enqueueVipAchievementCommunication(input())).rejects.toThrow(
    "account unavailable",
  );
});
it("propagates enqueue failure for transaction rollback", async () => {
  enqueue.mockRejectedValue(new Error("synthetic enqueue failure"));
  await expect(enqueueVipAchievementCommunication(input())).rejects.toThrow(
    "synthetic enqueue failure",
  );
});
