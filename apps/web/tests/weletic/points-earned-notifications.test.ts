import { beforeEach, expect, it, vi } from "vitest";
import type { CommunicationDeliveryClaim } from "../../lib/weletic/loyalty/communication-delivery-snapshot";
import { CommunicationDeliveryRecipientChangedError } from "../../lib/weletic/loyalty/communication-delivery-snapshot";
import { sendPointsEarnedNotification } from "../../lib/weletic/loyalty/points-earned-notifications";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  ledger: vi.fn(),
  grant: vi.fn(),
  order: vi.fn(),
  guard: vi.fn(),
  settings: vi.fn(),
  retain: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn(),
  sender: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: { findFirst: mocks.account },
    weleticPointsLedgerEntry: { findFirst: mocks.ledger },
    weleticLoyaltyEarnGrant: { findFirst: mocks.grant },
    weleticCommerceOrder: { findFirst: mocks.order },
  },
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.guard,
}));
vi.mock("@/lib/weletic/merchant-settings/communications", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/merchant-settings/communications")
  >()),
  readShopperCommunicationSettings: mocks.settings,
}));
vi.mock("@/lib/weletic/transactional-email", () => ({
  getWeleticTransactionalEmailOptions: mocks.sender,
}));
vi.mock("@dub/email", () => ({
  prepareResendEmail: mocks.prepare,
  sendPreparedResendEmail: mocks.send,
}));
vi.mock(
  "../../lib/weletic/loyalty/communication-delivery-snapshot",
  async (original) => ({
    ...(await original<
      typeof import("../../lib/weletic/loyalty/communication-delivery-snapshot")
    >()),
    retainCommunicationDeliveryRequest: mocks.retain,
  }),
);
vi.mock("../../lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: (metadata: unknown) =>
    metadata === "redacted",
}));

const at = new Date("2026-09-10T00:00:00Z");
const template = {
  subject: "Earned {{points}}",
  heading: "Points",
  body: "{{customer_first_name}}: {{points}} {{points_label}}",
  actionLabel: "View",
};
const policy = {
  journey: "points_earned",
  enabled: true,
  templates: {
    en: template,
    ja: { ...template, subject: "日本語 {{points}}" },
    vi: { ...template, subject: "Tiếng Việt {{points}}" },
  },
};
function fixture() {
  return {
    claim: {
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
          points: "15",
          ledgerPoints: "20",
          policyRevision: "a".repeat(64),
          policy: structuredClone(policy),
        },
      },
      ownerToken: "worker",
      claimedAt: at,
      attempt: 1,
    } satisfies CommunicationDeliveryClaim,
  };
}
function accountRow() {
  return {
    metadata: null,
    shopper: {
      email: "synthetic@example.com",
      firstName: "Synthetic",
      locale: "en",
      acceptsMarketing: true,
    },
    program: {
      id: "program",
      name: "Rewards",
      status: "active",
      killSwitchActive: false,
      pointNamePlural: "Points",
      metadata: {
        loyaltyCommunications: {
          version: 1,
          sequence: 1,
          policies: [structuredClone(policy)],
        },
      },
    },
    store: { shopDomain: "synthetic.myshopify.com" },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.account.mockResolvedValue(accountRow());
  mocks.ledger.mockResolvedValue({
    grantId: "grant",
    pointsDelta: BigInt(20),
    createdAt: at,
  });
  mocks.grant.mockResolvedValue({
    status: "partially_reversed",
    settledPoints: BigInt(15),
  });
  mocks.order.mockResolvedValue({ status: "partially_refunded" });
  mocks.settings.mockResolvedValue({
    brandName: "Company",
    logoUrl: null,
    accentColor: null,
    paused: false,
  });
  mocks.sender.mockReturnValue({ from: "Rewards <test@example.com>" });
  mocks.prepare.mockImplementation(async (options) => ({
    to: options.to,
    from: options.from,
    subject: options.subject,
    html: "synthetic-rendered-envelope",
  }));
  mocks.retain.mockImplementation(async ({ prepare }) => prepare());
  mocks.send.mockResolvedValue({ data: { id: "synthetic-provider-id" } });
});
it("uses the posted eligible amount, scoped identities and stable provider key", async () => {
  expect(await sendPointsEarnedNotification(fixture())).toBe("sent");
  expect(mocks.account).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        id: "account",
        storeId: "store",
        programId: "program",
        status: "active",
      },
    }),
  );
  expect(mocks.grant).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        id: "grant",
        storeId: "store",
        accountId: "account",
        programId: "program",
        orderId: "order",
      },
    }),
  );
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({ subject: "Earned 15" }),
    "loyalty-communication-job-job",
  );
});
it.each(["ja-JP", "vi-VN"])("renders the saved %s template", async (locale) => {
  const row = accountRow();
  row.shopper.locale = locale;
  mocks.account.mockResolvedValue(row);
  await sendPointsEarnedNotification(fixture());
  expect(mocks.prepare.mock.calls[0][0].subject).toBe(
    locale === "ja-JP" ? "日本語 15" : "Tiếng Việt 15",
  );
});
it.each([
  "consent",
  "email",
  "program",
  "kill",
  "policy",
  "missing-policy",
  "account",
  "redacted",
])("suppresses %s without preparing or sending", async (kind) => {
  const row = accountRow();
  if (kind === "consent") row.shopper.acceptsMarketing = false;
  if (kind === "email") row.shopper.email = "";
  if (kind === "program") row.program.id = "foreign";
  if (kind === "kill") row.program.killSwitchActive = true;
  if (kind === "policy")
    row.program.metadata.loyaltyCommunications.policies[0].enabled = false;
  if (kind === "missing-policy")
    row.program.metadata.loyaltyCommunications.policies = [];
  mocks.account.mockResolvedValue(
    kind === "account"
      ? null
      : kind === "redacted"
        ? { ...row, metadata: "redacted" }
        : row,
  );
  expect(await sendPointsEarnedNotification(fixture())).toBe("ineligible");
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it.each(["ledger", "amount", "grant", "later-refund", "full-refund", "order"])(
  "suppresses invalid or changed %s evidence",
  async (kind) => {
    if (kind === "ledger") mocks.ledger.mockResolvedValue(null);
    if (kind === "amount")
      mocks.ledger.mockResolvedValue({
        grantId: "grant",
        pointsDelta: BigInt(21),
        createdAt: at,
      });
    if (kind === "grant") mocks.grant.mockResolvedValue(null);
    if (kind === "later-refund")
      mocks.grant.mockResolvedValue({
        status: "partially_reversed",
        settledPoints: BigInt(14),
      });
    if (kind === "full-refund")
      mocks.grant.mockResolvedValue({
        status: "reversed",
        settledPoints: BigInt(0),
      });
    if (kind === "order") mocks.order.mockResolvedValue({ status: "refunded" });
    expect(await sendPointsEarnedNotification(fixture())).toBe("ineligible");
    expect(mocks.send).not.toHaveBeenCalled();
  },
);
it("defers paused email without consuming a provider attempt", async () => {
  mocks.settings.mockResolvedValue({ paused: true });
  await expect(sendPointsEarnedNotification(fixture())).rejects.toThrow(
    "Shopper email is paused",
  );
  expect(mocks.retain).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("keeps retained content unchanged even when current templates change", async () => {
  const retained = {
    to: "synthetic@example.com",
    from: "Saved sender",
    subject: "Saved subject",
    html: "saved-bytes",
  };
  mocks.retain.mockResolvedValue(retained);
  const row = accountRow();
  row.program.metadata.loyaltyCommunications.policies[0].templates.en.subject =
    "Changed";
  mocks.account.mockResolvedValue(row);
  await sendPointsEarnedNotification(fixture());
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledWith(
    retained,
    "loyalty-communication-job-job",
  );
});
it("does not redirect a changed retained recipient", async () => {
  mocks.retain.mockRejectedValue(
    new CommunicationDeliveryRecipientChangedError(),
  );
  expect(await sendPointsEarnedNotification(fixture())).toBe("ineligible");
  expect(mocks.send).not.toHaveBeenCalled();
});
it.each(["throw", "response"])(
  "sanitizes provider %s and performs no alternate send",
  async (kind) => {
    if (kind === "throw")
      mocks.send.mockRejectedValue(
        new Error("private@example.com provider body"),
      );
    else
      mocks.send.mockResolvedValue({
        error: { message: "private@example.com provider body" },
      });
    await expect(sendPointsEarnedNotification(fixture())).rejects.toThrow(
      /^Loyalty communication email provider unavailable$/,
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
  },
);
it("rejects foreign job scope before queries", async () => {
  const args = fixture();
  args.claim.candidate.storeId = "foreign";
  await expect(sendPointsEarnedNotification(args)).rejects.toThrow(
    "job unavailable",
  );
  expect(mocks.account).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
