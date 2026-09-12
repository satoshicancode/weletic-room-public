import { expect, it } from "vitest";
import {
  createReferralBenefitCommunication,
  matchesReferralBenefitCommunicationEvidence,
  projectReferralBenefitReceiptEvidence,
  referralBenefitCommunicationJobSchema,
  referralBenefitCommunicationSchema,
  referralBenefitReceiptEvidenceSchema,
  referralCommunicationKey,
} from "../../lib/weletic/loyalty/referral-benefit-communication-contract";
import { referralBenefitFixture as fixture } from "./referral-benefit-communication-fixture";

type Input = ReturnType<typeof fixture>;
const object = (value: unknown) => value as Record<string, unknown>;
it.each(["points", "coupon"] as const)(
  "validates %s receipts without fabricating a notification policy",
  (kind) => {
    const input = fixture(kind);
    const { policySnapshot: _policy, ...receiptInput } = input;
    const evidence = projectReferralBenefitReceiptEvidence(receiptInput, [
      "issued",
    ]);
    const {
      policy: _eventPolicy,
      policyRevision: _revision,
      ...expected
    } = createReferralBenefitCommunication(input);
    expect(evidence).toEqual(expected);
    expect(evidence).not.toHaveProperty("policy");
    expect(evidence).not.toHaveProperty("policyRevision");
    expect(() =>
      referralBenefitReceiptEvidenceSchema.parse({
        ...evidence,
        policy: input.policySnapshot.policy,
      }),
    ).toThrow();
    expect(() =>
      projectReferralBenefitReceiptEvidence(
        { ...receiptInput, expectedInstallationGeneration: "fresh" },
        ["issued"],
      ),
    ).toThrow();
  },
);
it("does not treat a used coupon as unused expiry evidence", () => {
  const { policySnapshot: _policy, ...input } = fixture("coupon");
  if (input.receipt.kind !== "coupon") throw new Error("fixture");
  input.receipt.redemption.status = "active";
  expect(
    projectReferralBenefitReceiptEvidence(input, ["issued", "active"]),
  ).toMatchObject({ benefitKind: "coupon" });
  input.receipt.redemption.status = "used";
  expect(() =>
    projectReferralBenefitReceiptEvidence(input, ["issued", "active"]),
  ).toThrow();
});
it.each(["advocate", "referee"] as const)(
  "projects exact points for %s without the other party's data",
  (side) => {
    const event = createReferralBenefitCommunication(fixture("points", side));
    expect(event).toMatchObject({
      benefitKind: "points",
      points: "9007199254740993",
      receiptId: "ledger",
    });
    expect(event.journey).toBe(
      side === "advocate" ? "referral_advocate" : "referral_friend",
    );
    expect(JSON.stringify(event)).not.toContain("private-");
  },
);
it.each(["advocate", "referee"] as const)(
  "projects only an issued coupon for %s",
  (side) => {
    const input = fixture("coupon", side);
    const event = createReferralBenefitCommunication(input);
    expect(event).toMatchObject({
      benefitKind: "coupon",
      receiptId: "redemption",
      occurredAt: "2026-09-13T00:00:02.000Z",
      reward: {
        name: "Original referral reward",
        value: "1234",
        currency: "USD",
      },
    });
    expect(JSON.stringify(event)).not.toMatch(
      /private-|WLR-|discountCode|customerSelectionDigest/,
    );
    expect(
      matchesReferralBenefitCommunicationEvidence({
        event,
        referral: input.referral,
        receipt: input.receipt,
      }),
    ).toBe(true);
  },
);
it.each(["points", "coupon"] as const)(
  "supports the preissued friend's account-backed advocate %s",
  (kind) => {
    const event = createReferralBenefitCommunication(
      fixture(kind, "advocate", "preissued_friend_claim"),
    );
    expect(event.journey).toBe("referral_advocate");
    expect(event.origin.qualificationPath).toBe("preissued_friend_claim");
  },
);
const commonRejections: Array<[string, (input: Input) => void]> = [
  [
    "foreign store",
    (x) => {
      x.referral.storeId = "other";
    },
  ],
  [
    "foreign referral",
    (x) => {
      x.referral.id = "other";
    },
  ],
  [
    "foreign recipient",
    (x) => {
      x.referral.advocateAccountId = "other";
    },
  ],
  [
    "different qualification order",
    (x) => {
      x.referral.qualifyingOrderId = "new-order";
    },
  ],
  [
    "different metadata order",
    (x) => {
      object(x.referral.metadata).qualificationOrderId = "new-order";
    },
  ],
  [
    "refunded qualification",
    (x) => {
      x.referral.status = "pending";
    },
  ],
  [
    "fraudulent qualification",
    (x) => {
      x.referral.status = "fraudulent";
    },
  ],
  [
    "fresh generation",
    (x) => {
      x.expectedInstallationGeneration = "fresh";
    },
  ],
  [
    "foreign program policy",
    (x) => {
      x.policySnapshot.programId = "other";
    },
  ],
  [
    "foreign store policy",
    (x) => {
      x.policySnapshot.storeId = "other";
    },
  ],
  [
    "wrong policy journey",
    (x) => {
      object(x.policySnapshot.policy).journey = "birthday";
    },
  ],
  [
    "missing historical origin",
    (x) => {
      delete object(x.referral.metadata).referralCommunicationOrigins;
    },
  ],
];
it.each(commonRejections)(
  "rejects %s for both benefit types",
  (_label, mutate) => {
    for (const kind of ["points", "coupon"] as const) {
      const input = fixture(kind);
      mutate(input);
      expect(() => createReferralBenefitCommunication(input)).toThrow();
    }
  },
);
it.each([
  ["entryType", "MANUAL_ADJUSTMENT"],
  ["referenceType", "referral_friend_claim"],
  ["referenceId", "other"],
  ["idempotencyKey", "other"],
  ["storeId", "other"],
  ["accountId", "other"],
  ["grantId", "import-grant"],
  ["pointsDelta", BigInt(1)],
] as const)("rejects wrong points receipt %s", (field, value) => {
  const input = fixture();
  if (input.receipt.kind !== "points") throw new Error("fixture");
  Object.assign(input.receipt.ledger, { [field]: value });
  expect(() => createReferralBenefitCommunication(input)).toThrow();
});
it("rejects points after a partial clawback, before qualification, or with foreign order metadata", () => {
  for (const mutate of [
    (x: Input) => {
      x.referral.advocatePointsAwarded -= BigInt(1);
    },
    (x: Input) => {
      if (x.receipt.kind === "points")
        x.receipt.ledger.createdAt = new Date("2026-09-12T00:00:00Z");
    },
    (x: Input) => {
      if (x.receipt.kind === "points")
        object(x.receipt.ledger.metadata).orderId = "foreign";
    },
  ]) {
    const input = fixture();
    mutate(input);
    expect(() => createReferralBenefitCommunication(input)).toThrow();
  }
});
it.each(["provisioning", "cancelled", "failed", "expired", "used", "active"])(
  "does not create a new coupon notice from %s",
  (status) => {
    const input = fixture("coupon");
    if (input.receipt.kind !== "coupon") throw new Error("fixture");
    input.receipt.redemption.status = status;
    expect(() => createReferralBenefitCommunication(input)).toThrow();
  },
);
it.each([
  ["storeId", "other"],
  ["accountId", "other"],
  ["rewardDefinitionId", "other"],
  ["artifactKind", "gift_card"],
  ["pointsSpent", BigInt(1)],
  ["ledgerEntryId", "paid-debit"],
  ["shopifyDiscountId", null],
  ["idempotencyKey", null],
  ["idempotencyKey", "another-side-key"],
  ["shopifyDiscountCode", "copied-code"],
  ["shopifyDiscountCodeCanonical", null],
  ["shopifyDiscountCodeCanonical", "OTHER"],
  ["settlementQuarantinedAt", new Date()],
] as const)("rejects wrong coupon receipt %s", (field, value) => {
  const input = fixture("coupon");
  if (input.receipt.kind !== "coupon") throw new Error("fixture");
  Object.assign(input.receipt.redemption, { [field]: value });
  expect(() => createReferralBenefitCommunication(input)).toThrow();
});
it.each([
  "referralId",
  "qualificationOrderId",
  "referralSide",
  "referralCommunicationIssuedAt",
  "shopifyDiscountOwnershipFingerprint",
  "shopifyDiscountProvisioningName",
  "shopifyDiscountExpectedTitle",
])("rejects missing coupon %s evidence", (field) => {
  const input = fixture("coupon");
  if (input.receipt.kind !== "coupon") throw new Error("fixture");
  delete object(input.receipt.redemption.metadata)[field];
  expect(() => createReferralBenefitCommunication(input)).toThrow();
});
it("rejects a tampered coupon snapshot and changed authoritative snapshot", () => {
  const input = fixture("coupon");
  if (input.receipt.kind !== "coupon") throw new Error("fixture");
  const copied = structuredClone(input);
  object(
    object(input.receipt.redemption.metadata).rewardSnapshot,
  ).discountValue = "999";
  expect(() => createReferralBenefitCommunication(input)).toThrow();
  object(
    object(object(copied.referral.metadata).referralCouponRewardSnapshots)
      .advocate,
  ).name = "Changed";
  expect(() => createReferralBenefitCommunication(copied)).toThrow();
});
it.each(["points", "coupon"] as const)(
  "rejects invalidated %s qualification orders even if status is still qualified",
  (kind) => {
    for (const value of [["order"], null, [1]]) {
      const input = fixture(kind);
      object(input.referral.metadata).invalidatedQualificationOrderIds = value;
      expect(() => createReferralBenefitCommunication(input)).toThrow();
    }
    const input = fixture(kind);
    object(input.referral.metadata).invalidatedQualificationOrderIds = [
      "earlier-order",
    ];
    expect(() => createReferralBenefitCommunication(input)).not.toThrow();
  },
);
it.each(["active", "used"])(
  "validates retained coupon evidence after %s without creating another event",
  (status) => {
    const input = fixture("coupon");
    const event = createReferralBenefitCommunication(input);
    if (input.receipt.kind !== "coupon") throw new Error("fixture");
    input.receipt.redemption.status = status;
    expect(
      matchesReferralBenefitCommunicationEvidence({
        event: { ...event, communicationDeliverySnapshot: "encrypted" },
        referral: input.referral,
        receipt: input.receipt,
      }),
    ).toBe(true);
    input.referral.qualifyingOrderId = "new-order";
    expect(
      matchesReferralBenefitCommunicationEvidence({
        event,
        referral: input.referral,
        receipt: input.receipt,
      }),
    ).toBe(false);
  },
);
it.each(["points", "coupon"] as const)(
  "strictly parses %s jobs and preserves original evidence",
  (kind) => {
    const input = fixture(kind);
    const event = createReferralBenefitCommunication(input);
    expect(
      referralBenefitCommunicationJobSchema.safeParse({
        ...event,
        communicationDeliverySnapshot: "encrypted",
      }).success,
    ).toBe(true);
    expect(
      referralBenefitCommunicationSchema.safeParse({
        ...event,
        email: "private@example.test",
      }).success,
    ).toBe(false);
    expect(
      referralBenefitCommunicationSchema.safeParse({
        ...event,
        accountId: "foreign",
      }).success,
    ).toBe(false);
    expect(
      referralBenefitCommunicationSchema.safeParse({
        ...event,
        journey: "birthday",
      }).success,
    ).toBe(false);
    expect(referralCommunicationKey(event)).toMatch(
      /^loyalty_communication:referral_benefit:[a-f0-9]{64}$/,
    );
    expect(
      matchesReferralBenefitCommunicationEvidence({
        event: { ...event, receiptId: "forged" },
        referral: input.referral,
        receipt: input.receipt,
      }),
    ).toBe(false);
  },
);
