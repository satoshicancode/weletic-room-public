import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { enqueueBirthdayCommunication } from "../../lib/weletic/loyalty/birthday-communication-producer";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../../lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: enqueue,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const program = vi.fn();
const account = vi.fn();
const store = vi.fn();
const tx = {
  weleticLoyaltyProgram: { findUnique: program },
  weleticLoyaltyAccount: { findFirst: account },
  weleticShopifyStore: { findUnique: store },
} as unknown as Prisma.TransactionClient;
const programRow = () => {
  const template = {
    subject: "Birthday",
    heading: "Celebrate",
    body: "{{points}}",
    actionLabel: "View",
  };
  return {
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
            journey: "birthday",
            enabled: true,
            templates: { en: template, ja: template, vi: template },
          },
        ],
      },
    },
  };
};
const input = () => ({
  tx,
  storeId: "store",
  calendarYear: 2026,
  receipt: {
    created: true,
    entry: {
      id: "ledger",
      storeId: "store",
      accountId: "account",
      entryType: "EARN_BONUS" as const,
      pointsDelta: BigInt(20),
      referenceType: "BIRTHDAY_REWARD",
      referenceId: "2026",
      idempotencyKey: "birthday:account:2026",
      grantId: null,
      createdAt: new Date("2026-09-10T00:00:00Z"),
    },
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  program.mockResolvedValue(programRow());
  account.mockResolvedValue({ id: "account" });
  store.mockResolvedValue({
    installationGeneration: "g1",
    storeAccessState: "active",
    complianceState: "active",
  });
  enqueue.mockResolvedValue({ created: true });
});
it("binds a fresh award to the caller transaction and birthday policy", async () => {
  await enqueueBirthdayCommunication(input());
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      tx,
      storeId: "store",
      jobType: "LOYALTY_COMMUNICATION",
      payload: expect.objectContaining({
        journey: "birthday",
        calendarYear: 2026,
        points: "20",
        installationGeneration: "g1",
      }),
    }),
  );
  expect(account).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        id: "account",
        storeId: "store",
        programId: "program",
        status: "active",
      },
    }),
  );
});
it("returns before reading current policy on replay", async () => {
  const args = input();
  args.receipt.created = false;
  expect(await enqueueBirthdayCommunication(args)).toBeNull();
  expect(program).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});
it("does not notify under a disabled birthday policy", async () => {
  const row = programRow();
  row.metadata.loyaltyCommunications.policies[0].enabled = false;
  program.mockResolvedValue(row);
  expect(await enqueueBirthdayCommunication(input())).toBeNull();
  expect(enqueue).not.toHaveBeenCalled();
});
it("propagates persistence failures to the enclosing award transaction", async () => {
  enqueue.mockRejectedValue(new Error("Synthetic persistence failure"));
  await expect(enqueueBirthdayCommunication(input())).rejects.toThrow(
    "Synthetic persistence failure",
  );
});
it.each(["account", "generation", "approval", "program"])(
  "rejects unavailable %s authority",
  async (kind) => {
    if (kind === "account") account.mockResolvedValue(null);
    if (kind === "generation")
      store.mockResolvedValue({
        storeAccessState: "active",
        complianceState: "active",
      });
    if (kind === "approval")
      store.mockResolvedValue({
        installationGeneration: "g1",
        storeAccessState: "pending_approval",
        complianceState: "active",
      });
    if (kind === "program") program.mockResolvedValue(null);
    await expect(enqueueBirthdayCommunication(input())).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  },
);
