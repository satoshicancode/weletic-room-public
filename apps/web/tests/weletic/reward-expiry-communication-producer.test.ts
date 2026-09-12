import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { loyaltyCommunicationJobPayloadSchema } from "../../lib/weletic/loyalty/points-communication-contract";
import { enqueueDueRewardExpiryCommunication } from "../../lib/weletic/loyalty/reward-expiry-communication-producer";
import { rewardExpiryCommunicationFixture } from "./reward-expiry-communication-fixture";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../../lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: enqueue,
}));
beforeEach(() => {
  enqueue.mockReset().mockResolvedValue({ created: true, job: { id: "job" } });
});
function fixture(kind: "redemption" | "referral_coupon" = "redemption") {
  const evidence = rewardExpiryCommunicationFixture(kind);
  const receipt = evidence.receipt;
  const row =
    receipt.kind === "redemption"
      ? receipt.input.redemption
      : receipt.input.receipt.kind === "coupon"
        ? receipt.input.receipt.redemption
        : null;
  if (!row) throw new Error("fixture");
  const program = {
    id: "program",
    storeId: "store",
    status: "active",
    killSwitchActive: false,
    metadata: {
      loyaltyCommunications: {
        version: 1,
        sequence: 1,
        policies: [evidence.policySnapshot.policy],
      },
    },
  };
  const store = {
    installationGeneration: "generation",
    storeAccessState: "active",
    complianceState: "active",
  };
  const account = {
    id: "account",
    metadata: null as Prisma.JsonValue | null,
    shopper: { acceptsMarketing: true },
  };
  const db = {
    weleticLoyaltyProgram: { findUnique: vi.fn().mockResolvedValue(program) },
    weleticShopifyStore: { findUnique: vi.fn().mockResolvedValue(store) },
    weleticLoyaltyAccount: { findFirst: vi.fn().mockResolvedValue(account) },
    weleticRewardRedemption: { findFirst: vi.fn().mockResolvedValue(row) },
    weleticPointsLedgerEntry: {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.referenceType === "REDEMPTION_REFUND"
            ? null
            : receipt.kind === "redemption"
              ? receipt.input.ledger
              : null,
        ),
    },
    weleticLoyaltyReferral: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          receipt.kind === "referral_coupon" ? receipt.input.referral : null,
        ),
    },
    weleticCommerceOrder: {
      findFirst: vi.fn().mockResolvedValue({ status: "paid" }),
    },
  };
  return {
    row,
    program,
    store,
    account,
    db,
    args: {
      tx: db as unknown as Prisma.TransactionClient,
      storeId: "store",
      redemptionId: row.id,
      expectedInstallationGeneration: "generation",
      now: evidence.now,
    },
  };
}
it.each(["redemption", "referral_coupon"] as const)(
  "queues due %s evidence with the held transaction and immutable key",
  async (kind) => {
    const { args } = fixture(kind);
    expect(await enqueueDueRewardExpiryCommunication(args)).toBe("enqueued");
    const queued = enqueue.mock.calls[0][0];
    expect(queued.tx).toBe(args.tx);
    expect(queued.scheduledFor).toEqual(args.now);
    expect(
      loyaltyCommunicationJobPayloadSchema.parse(queued.payload),
    ).toMatchObject({ source: "reward_expiry_due", receipt: { kind } });
    enqueue.mockResolvedValue({ created: false, job: { id: "job" } });
    expect(await enqueueDueRewardExpiryCommunication(args)).toBe("existing");
    expect(enqueue.mock.calls[1][0].idempotencyKey).toBe(queued.idempotencyKey);
  },
);
it.each(["redemption", "referral_coupon"] as const)(
  "rejects changed %s source, privacy and policy before enqueue",
  async (kind) => {
    for (const reason of [
      "used",
      "missing",
      "privacy",
      "consent",
      "disabled",
      "early",
      "expired",
      "foreign",
      "missing-source",
    ] as const) {
      enqueue.mockClear();
      const { args, row, account, program, db } = fixture(kind);
      if (reason === "used") row.status = "used";
      if (reason === "missing")
        db.weleticRewardRedemption.findFirst.mockResolvedValue(null);
      if (reason === "foreign") row.storeId = "other";
      if (reason === "consent") account.shopper.acceptsMarketing = false;
      if (reason === "privacy")
        account.metadata = {
          shopifyCustomerRedaction: {
            status: "redacted",
            redactedAt: "2026-10-10T00:00:00Z",
            source: "shopify_customers_redact",
          },
        };
      if (reason === "disabled")
        program.metadata.loyaltyCommunications.policies[0].enabled = false;
      if (reason === "early") args.now = new Date(args.now.getTime() - 1);
      if (reason === "expired") args.now = new Date("2026-10-13T00:00:00Z");
      if (reason === "missing-source") {
        db.weleticPointsLedgerEntry.findFirst.mockResolvedValue(null);
        db.weleticLoyaltyReferral.findFirst.mockResolvedValue(null);
      }
      expect(await enqueueDueRewardExpiryCommunication(args), reason).toBe(
        "ineligible",
      );
      expect(enqueue).not.toHaveBeenCalled();
    }
  },
);
it("propagates database and queue failures rather than advancing a sweep silently", async () => {
  const first = fixture();
  first.db.weleticRewardRedemption.findFirst.mockRejectedValue(
    new Error("synthetic database failure"),
  );
  await expect(enqueueDueRewardExpiryCommunication(first.args)).rejects.toThrow(
    "database failure",
  );
  enqueue.mockRejectedValue(new Error("synthetic queue failure"));
  await expect(
    enqueueDueRewardExpiryCommunication(fixture().args),
  ).rejects.toThrow("queue failure");
});
it.each(["generation", "approval", "compliance"])(
  "rejects changed installation %s",
  async (reason) => {
    const { args, store } = fixture();
    if (reason === "generation") store.installationGeneration = "fresh";
    if (reason === "approval") store.storeAccessState = "pending_approval";
    if (reason === "compliance") store.complianceState = "redacted";
    await expect(enqueueDueRewardExpiryCommunication(args)).rejects.toThrow(
      "installation changed",
    );
    expect(enqueue).not.toHaveBeenCalled();
  },
);
