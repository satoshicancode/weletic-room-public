import { beforeEach, expect, it, vi } from "vitest";
import type { CommunicationDeliveryClaim } from "../../lib/weletic/loyalty/communication-delivery-snapshot";
import { CommunicationDeliveryRecipientChangedError } from "../../lib/weletic/loyalty/communication-delivery-snapshot";
import { sendPointsEarnedNotification } from "../../lib/weletic/loyalty/points-earned-notifications";
import { createRewardRedeemedCommunication } from "../../lib/weletic/loyalty/reward-redeemed-communication-contract";
import { rewardCommunicationFixture } from "./reward-communication-fixture";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  ledger: vi.fn(),
  grant: vi.fn(),
  order: vi.fn(),
  history: vi.fn(),
  redemption: vi.fn(),
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
    weleticLoyaltyTierHistory: { findFirst: mocks.history },
    weleticRewardRedemption: { findFirst: mocks.redemption },
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
function signupFixture() {
  const value = fixture();
  const { orderId: _orderId, ...payload } = value.claim.candidate.payload;
  return {
    claim: {
      ...value.claim,
      candidate: {
        ...value.claim.candidate,
        payload: {
          ...payload,
          source: "signup_points_available",
          points: "20",
        },
      },
    },
  };
}
it("delivers a signup notice using exact signup ledger evidence without an order", async () => {
  mocks.ledger.mockResolvedValue({
    grantId: null,
    pointsDelta: BigInt(20),
    createdAt: at,
  });
  expect(await sendPointsEarnedNotification(signupFixture())).toBe("sent");
  expect(mocks.ledger).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        entryType: "EARN_BONUS",
        referenceType: "SIGNUP_BONUS",
        referenceId: "account",
      }),
    }),
  );
  expect(mocks.order).not.toHaveBeenCalled();
  expect(mocks.grant).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
it.each([
  null,
  { grantId: "foreign-grant", pointsDelta: BigInt(20), createdAt: at },
  { grantId: null, pointsDelta: BigInt(19), createdAt: at },
])("suppresses missing or mismatched signup ledger %#", async (ledger) => {
  mocks.ledger.mockResolvedValue(ledger);
  expect(await sendPointsEarnedNotification(signupFixture())).toBe(
    "ineligible",
  );
  expect(mocks.send).not.toHaveBeenCalled();
});
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
function birthdayFixture() {
  const args = fixture();
  const { orderId: _order, ...payload } = args.claim.candidate.payload;
  const birthdayPolicy = structuredClone(policy);
  birthdayPolicy.journey = "birthday";
  for (const locale of ["en", "ja", "vi"] as const)
    birthdayPolicy.templates[locale].subject =
      `${locale} birthday {{reward_name}}`;
  const row = accountRow();
  row.program.metadata.loyaltyCommunications.policies = [birthdayPolicy];
  mocks.account.mockResolvedValue(row);
  mocks.ledger.mockResolvedValue({
    grantId: null,
    pointsDelta: BigInt(20),
    createdAt: at,
  });
  return {
    row,
    args: {
      claim: {
        ...args.claim,
        candidate: {
          ...args.claim.candidate,
          payload: {
            ...payload,
            source: "birthday_points_available",
            journey: "birthday",
            calendarYear: 2026,
            points: "20",
            policy: birthdayPolicy,
          },
        },
      },
    },
  };
}
it.each(["en", "ja", "vi"])(
  "renders committed birthday rewards in %s without purchase evidence",
  async (locale) => {
    const { row, args } = birthdayFixture();
    row.shopper.locale = locale;
    expect(await sendPointsEarnedNotification(args)).toBe("sent");
    expect(mocks.ledger).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          referenceType: "BIRTHDAY_REWARD",
          referenceId: "2026",
          idempotencyKey: "birthday:account:2026",
        }),
      }),
    );
    expect(mocks.prepare.mock.calls[0][0].subject).toBe(
      `${locale} birthday 20 Points`,
    );
    expect(mocks.order).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  },
);
it("does not substitute an enabled points-earned policy for birthday consent", async () => {
  const { args } = birthdayFixture();
  mocks.account.mockResolvedValue(accountRow());
  expect(await sendPointsEarnedNotification(args)).toBe("ineligible");
  expect(mocks.send).not.toHaveBeenCalled();
});
it("rejects a grant-backed birthday ledger", async () => {
  const { args } = birthdayFixture();
  mocks.ledger.mockResolvedValue({
    grantId: "grant",
    pointsDelta: BigInt(20),
    createdAt: at,
  });
  expect(await sendPointsEarnedNotification(args)).toBe("ineligible");
  expect(mocks.send).not.toHaveBeenCalled();
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

function redemptionFixture(type = "amount_off") {
  const evidence = rewardCommunicationFixture(type);
  for (const locale of ["en", "ja", "vi"] as const) {
    evidence.policySnapshot.policy.templates[locale].subject =
      `${locale}: {{reward_name}} / {{reward_value}}`;
  }
  const row = accountRow();
  const event = createRewardRedeemedCommunication(evidence);
  mocks.account.mockResolvedValue({
    ...row,
    program: {
      ...row.program,
      metadata: {
        loyaltyCommunications: {
          version: 1,
          sequence: 1,
          policies: [event.policy],
        },
      },
    },
  });
  mocks.redemption.mockResolvedValue({
    ...evidence.redemption,
    expiresAt: null,
  });
  mocks.ledger.mockImplementation(async ({ where }) =>
    where.referenceType === "REDEMPTION_REFUND" ? null : evidence.ledger,
  );
  const args: { claim: CommunicationDeliveryClaim } = fixture();
  args.claim.candidate.payload = event;
  return { args, row, evidence, event };
}

it.each(["en", "ja", "vi"] as const)(
  "prepares captured redemption terms in %s (mocked renderer/provider)",
  async (locale) => {
    const { args, row } = redemptionFixture();
    row.shopper.locale = locale;
    expect(await sendPointsEarnedNotification(args)).toBe("sent");
    expect(mocks.prepare.mock.calls[0][0].subject).toBe(
      `${locale}: Original reward / 12.34 USD`,
    );
    expect(mocks.order).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledOnce();
  },
);

it.each(["cancelled", "failed", "expired"])(
  "suppresses a %s redemption before preparing delivery",
  async (status) => {
    const { args, evidence } = redemptionFixture();
    mocks.redemption.mockResolvedValue({ ...evidence.redemption, status });
    expect(await sendPointsEarnedNotification(args)).toBe("ineligible");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  },
);

it("suppresses a redemption with a compensation ledger entry", async () => {
  const { args, evidence } = redemptionFixture();
  mocks.ledger.mockImplementation(async ({ where }) =>
    where.referenceType === "REDEMPTION_REFUND"
      ? { id: "refund" }
      : evidence.ledger,
  );
  expect(await sendPointsEarnedNotification(args)).toBe("ineligible");
  expect(mocks.retain).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

function vipFixture() {
  const row = accountRow();
  const vipTemplate = {
    subject: "Welcome {{tier_name}}",
    heading: "VIP",
    body: "{{customer_first_name}} reached {{tier_name}}",
    actionLabel: "View",
  };
  const vipPolicy = {
    journey: "vip_achieved",
    enabled: true,
    templates: { en: vipTemplate, ja: vipTemplate, vi: vipTemplate },
  };
  row.program.metadata.loyaltyCommunications.policies = [
    structuredClone(vipPolicy),
  ];
  mocks.account.mockResolvedValue({ ...row, currentTierId: "gold" });
  const history = {
    id: "tier-history",
    sequenceNumber: 2,
    fromTierId: "bronze",
    toTierId: "gold",
    changeReason: "threshold_reached",
    effectiveAt: at,
    fromTier: { programId: "program" },
    toTier: { programId: "program" },
  };
  mocks.history.mockResolvedValue(history);
  const args: { claim: CommunicationDeliveryClaim } = fixture();
  args.claim.candidate.payload = {
    version: 1,
    journey: "vip_achieved",
    source: "vip_threshold_promotion",
    storeId: "store",
    programId: "program",
    accountId: "account",
    installationGeneration: "g1",
    tierHistoryId: history.id,
    sequenceNumber: 2,
    fromTier: { id: "bronze", rank: 1 },
    toTier: { id: "gold", rank: 3, name: "Gold" },
    occurredAt: at.toISOString(),
    policyRevision: "a".repeat(64),
    policy: vipPolicy,
  };
  return { args, row, history };
}
it("renders VIP achievement from captured tier name without invented points evidence", async () => {
  const { args } = vipFixture();
  expect(await sendPointsEarnedNotification(args)).toBe("sent");
  expect(mocks.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ subject: "Welcome Gold" }),
  );
  expect(mocks.ledger).not.toHaveBeenCalled();
  expect(mocks.grant).not.toHaveBeenCalled();
  expect(mocks.order).not.toHaveBeenCalled();
});
it.each([
  "id",
  "sequence",
  "from",
  "to",
  "reason",
  "time",
  "from-owner",
  "to-owner",
])("suppresses VIP notice when latest history changes %s", async (field) => {
  const { args, history } = vipFixture();
  if (field === "id") history.id = "later";
  if (field === "sequence") history.sequenceNumber = 3;
  if (field === "from") history.fromTierId = "other";
  if (field === "to") history.toTierId = "other";
  if (field === "reason") history.changeReason = "annual_downgrade";
  if (field === "time") history.effectiveAt = new Date(at.getTime() + 1000);
  if (field === "from-owner") history.fromTier.programId = "foreign";
  if (field === "to-owner") history.toTier.programId = "foreign";
  expect(await sendPointsEarnedNotification(args)).toBe("ineligible");
  expect(mocks.retain).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it.each(["tier", "policy", "consent", "privacy"])(
  "suppresses VIP after current %s changes",
  async (field) => {
    const { args, row } = vipFixture();
    if (field === "policy")
      row.program.metadata.loyaltyCommunications.policies[0].enabled = false;
    if (field === "consent") row.shopper.acceptsMarketing = false;
    mocks.account.mockResolvedValue({
      ...row,
      currentTierId: field === "tier" ? "bronze" : "gold",
      metadata: field === "privacy" ? "redacted" : null,
    });
    expect(await sendPointsEarnedNotification(args)).toBe("ineligible");
    expect(mocks.send).not.toHaveBeenCalled();
  },
);
