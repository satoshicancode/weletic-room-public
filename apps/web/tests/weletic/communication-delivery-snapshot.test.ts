import { encrypt } from "@/lib/encryption";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CommunicationDeliveryRecipientChangedError,
  CommunicationDeliveryReconciliationRequiredError,
  communicationDeliveryProviderKey,
  retainCommunicationDeliveryRequest,
  type CommunicationDeliveryClaim,
} from "../../lib/weletic/loyalty/communication-delivery-snapshot";
import { purchasePointsCommunicationSchema } from "../../lib/weletic/loyalty/points-communication-contract";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  account: vi.fn(),
  fence: vi.fn(),
  program: vi.fn(),
  settings: vi.fn(),
  recipient: vi.fn(),
  history: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  assertActiveLoyaltyAccountForMutation: mocks.account,
  withActiveStoreLoyaltyMutation: mocks.fence,
}));
const at = new Date("2026-09-10T00:00:00Z");
const request = {
  to: "synthetic@example.com",
  from: "Rewards <test@example.com>",
  subject: "Earned 20",
  html: "<p>20 synthetic points</p>",
};
function fixture() {
  const template = {
    subject: "Points",
    heading: "Points",
    body: "{{points}}",
    actionLabel: "View",
  };
  const claim: CommunicationDeliveryClaim = {
    candidate: {
      id: "job",
      storeId: "store",
      jobType: "LOYALTY_COMMUNICATION",
      status: "pending",
      idempotencyKey: "event-key",
      scheduledFor: at,
      createdAt: at,
      updatedAt: at,
      attempts: 0,
      maxAttempts: 5,
      priority: 0,
      lockedAt: null,
      lockedBy: null,
      processedAt: null,
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
      errorLog: [],
      payload: {
        version: 1,
        journey: "points_earned",
        source: "purchase_points_available",
        storeId: "store",
        programId: "program",
        accountId: "account",
        installationGeneration: "g1",
        ledgerEntryId: "ledger",
        orderId: "order",
        occurredAt: at.toISOString(),
        points: "20",
        ledgerPoints: "20",
        policyRevision: "a".repeat(64),
        policy: {
          journey: "points_earned",
          enabled: true,
          templates: { en: template, ja: template, vi: template },
        },
      },
    },
    ownerToken: "worker",
    claimedAt: at,
    attempt: 1,
  };
  return {
    claim,
    accountId: "account",
    expectedInstallationGeneration: "g1",
    recipientEmail: request.to,
    prepare: vi.fn().mockResolvedValue(request),
    wallClockNow: at,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ENCRYPTION_KEY", "test-only-communication-key-never-for-runtime");
  mocks.findFirst.mockResolvedValue({ id: "job", updatedAt: at });
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.account.mockResolvedValue({ id: "account" });
  mocks.program.mockResolvedValue({
    id: "program",
    status: "active",
    killSwitchActive: false,
    metadata: {
      loyaltyCommunications: {
        version: 1,
        sequence: 1,
        policies: [
          (fixture().claim.candidate.payload as { policy: unknown }).policy,
        ],
      },
    },
  });
  mocks.settings.mockResolvedValue({ shopperEmailPaused: false });
  mocks.recipient.mockResolvedValue({
    shopper: { email: request.to, acceptsMarketing: true },
  });
  mocks.fence.mockImplementation(async ({ operation }) =>
    operation({
      weleticLoyaltyProgram: { findUnique: mocks.program },
      weleticMerchantSettings: { findUnique: mocks.settings },
      weleticLoyaltyAccount: { findFirst: mocks.recipient },
      weleticLoyaltyTierHistory: { findFirst: mocks.history },
      weleticLoyaltyOutboxJob: {
        findFirst: mocks.findFirst,
        updateMany: mocks.updateMany,
      },
    }),
  );
});
afterEach(() => vi.unstubAllEnvs());

function birthdayFixture(enabled = true) {
  const args = fixture();
  const { orderId: _order, ...payload } =
    purchasePointsCommunicationSchema.parse(args.claim.candidate.payload);
  const policy = { ...payload.policy, journey: "birthday", enabled };
  args.claim.candidate.payload = {
    ...payload,
    journey: "birthday",
    source: "birthday_points_available",
    calendarYear: 2026,
    policy,
  };
  const program = {
    id: "program",
    status: "active",
    killSwitchActive: false,
    metadata: {
      loyaltyCommunications: {
        version: 1,
        sequence: 1,
        policies: [
          structuredClone(policy),
          { ...payload.policy, enabled: !enabled },
        ],
      },
    },
  };
  mocks.program.mockResolvedValue(program);
  return { args, program };
}

it("retains and retries birthday content while the points-earned journey is disabled", async () => {
  const { args } = birthdayFixture();
  expect(await retainCommunicationDeliveryRequest(args)).toEqual(request);
  expect(args.claim.candidate.payload).toHaveProperty(
    "communicationDeliverySnapshot",
  );
  args.prepare.mockClear();
  expect(await retainCommunicationDeliveryRequest(args)).toEqual(request);
  expect(args.prepare).not.toHaveBeenCalled();
});

function vipFixture() {
  const args = fixture();
  mocks.recipient.mockResolvedValue({
    currentTierId: "gold",
    shopper: { email: request.to, acceptsMarketing: true },
  });
  mocks.history.mockResolvedValue({
    id: "history",
    sequenceNumber: 1,
    fromTierId: "bronze",
    toTierId: "gold",
    changeReason: "threshold_reached",
    effectiveAt: at,
    fromTier: { programId: "program" },
    toTier: { programId: "program" },
  });
  const template = {
    subject: "VIP {{tier_name}}",
    heading: "VIP",
    body: "Welcome",
    actionLabel: "View",
  };
  const policy = {
    journey: "vip_achieved",
    enabled: true,
    templates: { en: template, ja: template, vi: template },
  };
  args.claim.candidate.payload = {
    version: 1,
    journey: "vip_achieved",
    source: "vip_threshold_promotion",
    storeId: "store",
    programId: "program",
    accountId: "account",
    installationGeneration: "g1",
    tierHistoryId: "history",
    sequenceNumber: 1,
    fromTier: { id: "bronze", rank: 1 },
    toTier: { id: "gold", rank: 3, name: "Gold" },
    occurredAt: at.toISOString(),
    policyRevision: "a".repeat(64),
    policy,
  };
  const currentPolicy = structuredClone(policy);
  mocks.program.mockResolvedValue({
    id: "program",
    status: "active",
    killSwitchActive: false,
    metadata: {
      loyaltyCommunications: {
        version: 1,
        sequence: 1,
        policies: [currentPolicy],
      },
    },
  });
  return { args, currentPolicy };
}
it.each([false, true])(
  "rejects a superseding VIP transition at fenced retention admission (retry=%s)",
  async (retry) => {
    const { args } = vipFixture();
    if (retry) await retainCommunicationDeliveryRequest(args);
    // Event passed its earlier sender check; a SQL-only writer wins before the
    // retention fence. A re-promotion to the same tier still has newer history.
    mocks.history.mockResolvedValue({
      id: "later",
      sequenceNumber: 3,
      fromTierId: "bronze",
      toTierId: "gold",
      changeReason: "threshold_reached",
      effectiveAt: at,
      fromTier: { programId: "program" },
      toTier: { programId: "program" },
    });
    args.prepare.mockClear();
    mocks.updateMany.mockClear();
    await expect(retainCommunicationDeliveryRequest(args)).rejects.toThrow(
      "no longer eligible",
    );
    expect(args.prepare).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  },
);
it("retains and retries VIP requests without a points-earned policy", async () => {
  const { args } = vipFixture();
  expect(await retainCommunicationDeliveryRequest(args)).toEqual(request);
  args.prepare.mockClear();
  expect(await retainCommunicationDeliveryRequest(args)).toEqual(request);
  expect(args.prepare).not.toHaveBeenCalled();
});
it.each([false, true])(
  "rechecks VIP policy disablement before retention/retry (%s)",
  async (retry) => {
    const { args, currentPolicy } = vipFixture();
    if (retry) await retainCommunicationDeliveryRequest(args);
    currentPolicy.enabled = false;
    expect(args.claim.candidate.payload).toHaveProperty("policy.enabled", true);
    args.prepare.mockClear();
    mocks.updateMany.mockClear();
    await expect(retainCommunicationDeliveryRequest(args)).rejects.toThrow(
      "no longer eligible",
    );
    expect(args.prepare).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "does not substitute points-earned enablement for birthday admission (retry=%s)",
  async (retry) => {
    const { args, program } = birthdayFixture();
    if (retry) await retainCommunicationDeliveryRequest(args);
    program.metadata.loyaltyCommunications.policies[0].enabled = false;
    program.metadata.loyaltyCommunications.policies[1].enabled = true;
    expect(args.claim.candidate.payload).toHaveProperty("policy.enabled", true);
    args.prepare.mockClear();
    mocks.updateMany.mockClear();
    await expect(retainCommunicationDeliveryRequest(args)).rejects.toThrow(
      "no longer eligible",
    );
    expect(args.prepare).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  },
);

it.each([
  [false, "program"],
  [true, "program"],
  [false, "policy"],
  [true, "policy"],
  [false, "pause"],
  [true, "pause"],
  [false, "consent"],
  [true, "consent"],
  [false, "recipient"],
  [true, "recipient"],
] as const)(
  "rechecks change-first admission gates (retry=%s, gate=%s)",
  async (retry, gate) => {
    const args = fixture();
    if (retry) await retainCommunicationDeliveryRequest(args);
    args.prepare.mockClear();
    mocks.updateMany.mockClear();
    if (gate === "program")
      mocks.program.mockResolvedValue({ id: "program", status: "paused" });
    if (gate === "policy")
      mocks.program.mockResolvedValue({
        id: "program",
        status: "active",
        killSwitchActive: false,
        metadata: null,
      });
    if (gate === "pause")
      mocks.settings.mockResolvedValue({ shopperEmailPaused: true });
    if (gate === "consent")
      mocks.recipient.mockResolvedValue({
        shopper: { email: request.to, acceptsMarketing: false },
      });
    if (gate === "recipient")
      mocks.recipient.mockResolvedValue({
        shopper: { email: "changed@example.com", acceptsMarketing: true },
      });
    await expect(retainCommunicationDeliveryRequest(args)).rejects.toThrow();
    expect(args.prepare).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  },
);

it("encrypts the exact request with full claim and installation fences", async () => {
  const args = fixture();
  const originalPayload = structuredClone(args.claim.candidate.payload);
  expect(await retainCommunicationDeliveryRequest(args)).toEqual(request);
  expect(mocks.fence).toHaveBeenCalledWith(
    expect.objectContaining({
      storeId: "store",
      expectedInstallationGeneration: "g1",
    }),
  );
  expect(mocks.updateMany).toHaveBeenCalledWith({
    where: {
      id: "job",
      storeId: "store",
      jobType: "LOYALTY_COMMUNICATION",
      status: "processing",
      lockedBy: "worker",
      lockedAt: at,
      attempts: 1,
      updatedAt: at,
      payload: { equals: originalPayload },
    },
    data: {
      payload: expect.objectContaining({
        communicationDeliverySnapshot: expect.any(String),
      }),
    },
  });
  const persisted = JSON.stringify(mocks.updateMany.mock.calls[0][0]);
  expect(persisted).not.toContain(request.to);
  expect(persisted).not.toContain(request.html);
  expect(communicationDeliveryProviderKey(args.claim)).toBe(
    "loyalty-communication-job-job",
  );
});
it("reuses retained bytes and does not prepare again", async () => {
  const args = fixture();
  await retainCommunicationDeliveryRequest(args);
  args.prepare.mockResolvedValue({ ...request, html: "changed" });
  expect(await retainCommunicationDeliveryRequest(args)).toEqual(request);
  expect(args.prepare).toHaveBeenCalledTimes(1);
  expect(mocks.updateMany).toHaveBeenCalledTimes(1);
});
it("suppresses changed recipients instead of redirecting the retained request", async () => {
  const args = fixture();
  await retainCommunicationDeliveryRequest(args);
  args.recipientEmail = "changed@example.com";
  await expect(retainCommunicationDeliveryRequest(args)).rejects.toBeInstanceOf(
    CommunicationDeliveryRecipientChangedError,
  );
  expect(args.prepare).toHaveBeenCalledTimes(1);
});
it.each([-1, 23 * 60 * 60 * 1000])(
  "requires reconciliation outside the safe retry window (%s)",
  async (offset) => {
    const args = fixture();
    await retainCommunicationDeliveryRequest(args);
    args.wallClockNow = new Date(at.getTime() + offset);
    await expect(
      retainCommunicationDeliveryRequest(args),
    ).rejects.toBeInstanceOf(CommunicationDeliveryReconciliationRequiredError);
    expect(args.prepare).toHaveBeenCalledTimes(1);
  },
);
it("rejects an unexpected rendered recipient before persistence", async () => {
  const args = fixture();
  args.prepare.mockResolvedValue({ ...request, to: "foreign@example.com" });
  await expect(retainCommunicationDeliveryRequest(args)).rejects.toThrow(
    "evidence unavailable",
  );
  expect(mocks.updateMany).not.toHaveBeenCalled();
});
it.each(["store", "account", "generation", "type", "claim", "payload"])(
  "rejects mismatched %s before rendering",
  async (kind) => {
    const args = fixture();
    if (kind === "store") args.claim.candidate.storeId = "foreign";
    if (kind === "account") args.accountId = "foreign";
    if (kind === "generation") args.expectedInstallationGeneration = "g2";
    if (kind === "type") args.claim.candidate.jobType = "INACTIVITY_EXPIRY";
    if (kind === "claim") args.claim.attempt = 0;
    if (kind === "payload")
      args.claim.candidate.payload = { email: "private@example.com" };
    await expect(retainCommunicationDeliveryRequest(args)).rejects.toThrow(
      "evidence unavailable",
    );
    expect(args.prepare).not.toHaveBeenCalled();
  },
);
it.each(["claim", "cas", "commit"])(
  "does not update local claim after failed %s",
  async (kind) => {
    const args = fixture();
    const original = structuredClone(args.claim.candidate.payload);
    if (kind === "claim") mocks.findFirst.mockResolvedValue(null);
    if (kind === "cas") mocks.updateMany.mockResolvedValue({ count: 0 });
    if (kind === "commit")
      mocks.fence.mockRejectedValue(
        new Error("synthetic transaction rollback"),
      );
    await expect(retainCommunicationDeliveryRequest(args)).rejects.toThrow();
    expect(args.claim.candidate.payload).toEqual(original);
  },
);
it("sanitizes decryption and parser failures", async () => {
  const args = fixture();
  args.claim.candidate.payload = {
    ...(args.claim.candidate.payload as object),
    communicationDeliverySnapshot: encrypt(
      JSON.stringify({ recipientEmail: "private@example.com" }),
    ),
  };
  await expect(retainCommunicationDeliveryRequest(args)).rejects.toThrow(
    /^Loyalty communication delivery evidence unavailable$/,
  );
  expect(args.prepare).not.toHaveBeenCalled();
});
