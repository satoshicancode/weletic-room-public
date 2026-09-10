import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import {
  enqueuePurchasePointsCommunication,
  enqueueSignupPointsCommunication,
} from "../../lib/weletic/loyalty/points-communication-producer";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../../lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: enqueue,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const template = {
  subject: "Earned {{points}}",
  heading: "Points",
  body: "Your points",
  actionLabel: "View",
};
const policy = {
  journey: "points_earned",
  enabled: true,
  templates: { en: template, ja: template, vi: template },
};
const program = vi.fn();
const account = vi.fn();
const grant = vi.fn();
const order = vi.fn();
const store = vi.fn();
const tx = {
  weleticLoyaltyProgram: { findUnique: program },
  weleticLoyaltyAccount: { findFirst: account },
  weleticLoyaltyEarnGrant: { findFirst: grant },
  weleticCommerceOrder: { findFirst: order },
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
      policies: [structuredClone(policy)],
    },
  },
});
const input = () => ({
  tx,
  storeId: "store",
  programId: "program",
  receipt: {
    created: true,
    entry: {
      id: "ledger",
      storeId: "store",
      accountId: "account",
      entryType: "EARN_ORDER" as const,
      pointsDelta: BigInt(20),
      referenceType: "COMMERCE_ORDER",
      referenceId: "order",
      grantId: "grant",
      createdAt: new Date("2026-09-10T00:00:00Z"),
    },
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  program.mockResolvedValue(programRow());
  account.mockResolvedValue({ id: "account" });
  grant.mockResolvedValue({ status: "settled", settledPoints: BigInt(20) });
  order.mockResolvedValue({ status: "paid" });
  store.mockResolvedValue({
    installationGeneration: "g1",
    storeAccessState: "active",
    complianceState: "active",
  });
  enqueue.mockResolvedValue({ created: true });
});
function signupInput() {
  const data = input();
  return {
    ...data,
    receipt: {
      ...data.receipt,
      entry: {
        ...data.receipt.entry,
        entryType: "EARN_BONUS" as const,
        referenceType: "SIGNUP_BONUS",
        referenceId: "account",
        grantId: null,
      },
    },
  };
}
it("enqueues signup evidence without reading a purchase grant or order", async () => {
  await enqueueSignupPointsCommunication(signupInput());
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      tx,
      payload: expect.objectContaining({
        source: "signup_points_available",
        points: "20",
      }),
    }),
  );
  expect(grant).not.toHaveBeenCalled();
  expect(order).not.toHaveBeenCalled();
});
it("never snapshots a replayed signup receipt under a newer policy", async () => {
  const data = signupInput();
  data.receipt.created = false;
  expect(await enqueueSignupPointsCommunication(data)).toBeNull();
  expect(program).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});
it("does not enqueue signup for a disabled communication policy", async () => {
  const row = programRow();
  row.metadata.loyaltyCommunications.policies[0].enabled = false;
  program.mockResolvedValue(row);
  expect(await enqueueSignupPointsCommunication(signupInput())).toBeNull();
  expect(enqueue).not.toHaveBeenCalled();
});
it("fails atomically when the signup account is outside the program", async () => {
  account.mockResolvedValue(null);
  await expect(
    enqueueSignupPointsCommunication(signupInput()),
  ).rejects.toThrow();
  expect(enqueue).not.toHaveBeenCalled();
});
it("enqueues bound evidence using the caller transaction", async () => {
  await enqueuePurchasePointsCommunication(input());
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      tx,
      storeId: "store",
      jobType: "LOYALTY_COMMUNICATION",
      payload: expect.objectContaining({
        ledgerEntryId: "ledger",
        accountId: "account",
        programId: "program",
        points: "20",
        ledgerPoints: "20",
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
  expect(grant).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        id: "grant",
        storeId: "store",
        programId: "program",
        accountId: "account",
        orderId: "order",
      },
    }),
  );
});
it("does not read or enqueue on replay", async () => {
  const data = input();
  data.receipt.created = false;
  expect(await enqueuePurchasePointsCommunication(data)).toBeNull();
  expect(program).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});
it.each(["absent", "disabled", "paused"])(
  "skips %s policy/program",
  async (kind) => {
    const row = programRow();
    if (kind === "absent") row.metadata.loyaltyCommunications.policies = [];
    if (kind === "disabled")
      row.metadata.loyaltyCommunications.policies[0].enabled = false;
    if (kind === "paused") row.killSwitchActive = true;
    program.mockResolvedValue(row);
    expect(await enqueuePurchasePointsCommunication(input())).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  },
);
it.each(["program", "account", "grant", "installation"])(
  "rejects missing/mismatched %s authority",
  async (kind) => {
    if (kind === "program")
      program.mockResolvedValue({ ...programRow(), id: "foreign" });
    if (kind === "account") account.mockResolvedValue(null);
    if (kind === "grant") grant.mockResolvedValue(null);
    if (kind === "installation")
      store.mockResolvedValue({
        installationGeneration: "g1",
        storeAccessState: "pending_approval",
        complianceState: "active",
      });
    await expect(enqueuePurchasePointsCommunication(input())).rejects.toThrow(
      "unavailable",
    );
    expect(enqueue).not.toHaveBeenCalled();
  },
);
it.each(["pending", "refunded", "voided"])(
  "does not notify %s orders",
  async (status) => {
    order.mockResolvedValue({ status });
    expect(await enqueuePurchasePointsCommunication(input())).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  },
);
it("announces only the amount still eligible after a persisted partial refund", async () => {
  grant.mockResolvedValue({
    status: "partially_reversed",
    settledPoints: BigInt(15),
  });
  order.mockResolvedValue({ status: "partially_refunded" });
  await enqueuePurchasePointsCommunication(input());
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({ points: "15", ledgerPoints: "20" }),
    }),
  );
});
it("skips fully reversed grants", async () => {
  grant.mockResolvedValue({ status: "reversed", settledPoints: BigInt(0) });
  expect(await enqueuePurchasePointsCommunication(input())).toBeNull();
  expect(enqueue).not.toHaveBeenCalled();
});
it("propagates enqueue failure so the caller transaction can roll back", async () => {
  enqueue.mockRejectedValue(new Error("synthetic enqueue failure"));
  await expect(enqueuePurchasePointsCommunication(input())).rejects.toThrow(
    "synthetic enqueue failure",
  );
});
