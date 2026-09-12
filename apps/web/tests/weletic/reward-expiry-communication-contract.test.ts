import { expect, it, vi } from "vitest";
import {
  createRewardExpiryCommunication,
  matchesRewardExpiryCommunicationEvidence,
  rewardExpiryCommunicationJobSchema,
  rewardExpiryCommunicationKey,
  rewardExpiryCommunicationSchema,
} from "../../lib/weletic/loyalty/reward-expiry-communication-contract";
import { isCurrentRewardExpiryReceipt } from "../../lib/weletic/loyalty/reward-expiry-communication-source";
import { matchesRewardExpiryDiscountEvidence } from "../../lib/weletic/loyalty/reward-expiry-discount-evidence";
import {
  lookupDiscountByCode,
  type ShopifyDiscountResult,
} from "../../lib/weletic/loyalty/shopify-discounts";
import { referralBenefitFixture } from "./referral-benefit-communication-fixture";

import { rewardExpiryCommunicationFixture as fixture } from "./reward-expiry-communication-fixture";
const object = (value: unknown) => value as Record<string, unknown>;
it("does not fabricate active status from an incomplete Shopify lookup response", async () => {
  const transport = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: {
          codeDiscountNodeByCode: {
            id: "synthetic-node",
            codeDiscount: {
              title: "synthetic-title",
              codes: {
                nodes: [
                  { id: "synthetic-code", code: "TEST", asyncUsageCount: 0 },
                ],
              },
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  const result = await lookupDiscountByCode(
    "synthetic.myshopify.com",
    "synthetic-token",
    "TEST",
    transport,
  );
  expect(result?.status).toBe("");
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each(["redemption", "referral_coupon"] as const)(
  "freezes a due %s receipt without private artifact details",
  (kind) => {
    const input = fixture(kind);
    const event = createRewardExpiryCommunication(input);
    expect(event).toMatchObject({
      journey: "reward_expiry",
      source: "reward_expiry_due",
      receipt: { kind },
      dueAt: "2026-10-10T00:00:00.000Z",
      expiresAt: "2026-10-13T00:00:00.000Z",
    });
    expect(JSON.stringify(event)).not.toMatch(
      /PRIVATE-|private-|WLR-|discountCode|shopifyDiscountId/,
    );
    expect(
      matchesRewardExpiryCommunicationEvidence({
        event,
        receipt: input.receipt,
        now: input.now,
      }),
    ).toBe(true);
    expect(
      rewardExpiryCommunicationJobSchema.parse({
        ...event,
        communicationDeliverySnapshot: "encrypted",
      }),
    ).toMatchObject(event);
  },
);

it.each(["redemption", "referral_coupon"] as const)(
  "requires exact current Shopify configuration for %s, not just local status",
  (kind) => {
    const input = fixture(kind);
    const event = createRewardExpiryCommunication(input);
    const receipt = input.receipt;
    const row =
      receipt.kind === "redemption"
        ? receipt.input.redemption
        : receipt.input.receipt.kind === "coupon"
          ? receipt.input.receipt.redemption
          : null;
    if (!row) throw new Error("fixture");
    const metadata = object(row.metadata);
    const remote: ShopifyDiscountResult = {
      id: row.shopifyDiscountId!,
      code: row.shopifyDiscountCode!,
      title:
        kind === "redemption"
          ? String(object(metadata.shopifyDiscountOwnership).expectedTitle)
          : String(metadata.shopifyDiscountExpectedTitle),
      status: "ACTIVE",
      asyncUsageCount: 0,
      configuration: {
        kind: "basic",
        startsAt:
          kind === "redemption"
            ? "2026-09-12T00:00:00.000Z"
            : "2026-09-13T00:00:00.000Z",
        endsAt: event.expiresAt,
        usageLimit: 1,
        appliesOncePerCustomer: kind === "referral_coupon",
        appliesOnOneTimePurchase: true,
        appliesOnSubscription: false,
        recurringCycleLimit: 1,
        combinesWith: {
          orderDiscounts: false,
          productDiscounts: false,
          shippingDiscounts: false,
        },
        customerSelection: {
          kind: "customers",
          customerIds: ["gid://shopify/Customer/private-customer"],
        },
        minimumRequirement: null,
        basicValue: {
          kind: "amount",
          amount: "12.34",
          currencyCode: "USD",
          appliesOnEachItem: false,
        },
        basicItems: { kind: "all" },
      },
    };
    const check = (
      candidate: ShopifyDiscountResult | null,
      customer = "gid://shopify/Customer/private-customer",
    ) =>
      matchesRewardExpiryDiscountEvidence({
        event,
        receipt,
        remote: candidate,
        shopifyCustomerId: customer,
        now: input.now,
      });
    expect(check(remote)).toBe(true);
    expect(check(null)).toBe(false);
    expect(check(remote, "gid://shopify/Customer/other")).toBe(false);
    for (const patch of [
      { id: "replacement" },
      { code: "OTHER" },
      { title: "OTHER" },
      { status: "INACTIVE" },
      { status: "EXPIRED" },
      { status: "SCHEDULED" },
      { asyncUsageCount: 1 },
      { asyncUsageCount: undefined },
      { configuration: undefined },
    ])
      expect(check({ ...remote, ...patch })).toBe(false);
    for (const patch of [
      { endsAt: "2026-10-14T00:00:00Z" },
      { startsAt: "2026-09-11T00:00:00Z" },
      { usageLimit: 2 },
      { appliesOnSubscription: true },
      { recurringCycleLimit: 2 },
      { customerSelection: { kind: "all" } as const },
      {
        combinesWith: {
          orderDiscounts: true,
          productDiscounts: false,
          shippingDiscounts: false,
        },
      },
      {
        basicValue: {
          kind: "amount",
          amount: "99.99",
          currencyCode: "USD",
          appliesOnEachItem: false,
        } as const,
      },
    ])
      expect(
        check({
          ...remote,
          configuration: { ...remote.configuration!, ...patch },
        }),
      ).toBe(false);
  },
);

it.each(["redemption", "referral_coupon"] as const)(
  "enforces exact timing and stable deduplication for %s",
  (kind) => {
    const input = fixture(kind);
    const event = createRewardExpiryCommunication(input);
    expect(() =>
      createRewardExpiryCommunication({
        ...input,
        now: new Date(input.now.getTime() - 1),
      }),
    ).toThrow();
    expect(() =>
      createRewardExpiryCommunication({
        ...input,
        now: new Date(event.expiresAt),
      }),
    ).toThrow();
    const later = createRewardExpiryCommunication({
      ...input,
      now: new Date(input.now.getTime() + 1000),
      policySnapshot: { ...input.policySnapshot, revision: "b".repeat(64) },
    });
    expect(rewardExpiryCommunicationKey(later)).toBe(
      rewardExpiryCommunicationKey(event),
    );
    expect(
      matchesRewardExpiryCommunicationEvidence({
        event,
        receipt: input.receipt,
        now: new Date(event.expiresAt),
      }),
    ).toBe(false);
    expect(
      matchesRewardExpiryCommunicationEvidence({
        event,
        receipt: input.receipt,
        now: new Date(NaN),
      }),
    ).toBe(false);
  },
);

it.each(["redemption", "referral_coupon"] as const)(
  "fails closed on changed %s evidence and policy ownership",
  (kind) => {
    for (const change of [
      "used",
      "cancelled",
      "quarantined",
      "expiry",
      "account",
      "generation",
      "policy-store",
      "policy-program",
      "disabled",
      "journey",
    ] as const) {
      const input = fixture(kind);
      const event = createRewardExpiryCommunication(input);
      const receipt = input.receipt;
      const row =
        receipt.kind === "redemption"
          ? receipt.input.redemption
          : receipt.input.receipt.kind === "coupon"
            ? receipt.input.receipt.redemption
            : null;
      if (!row) throw new Error("fixture");
      switch (change) {
        case "used":
        case "cancelled":
          row.status = change;
          break;
        case "quarantined":
          row.settlementQuarantinedAt = input.now;
          break;
        case "expiry":
          row.expiresAt = new Date("2026-10-14T00:00:00Z");
          break;
        case "account":
          row.accountId = "other";
          break;
        case "generation":
          if (receipt.kind === "redemption")
            receipt.input.installationGeneration = "fresh";
          else receipt.input.expectedInstallationGeneration = "fresh";
          break;
        case "policy-store":
          input.policySnapshot.storeId = "other";
          break;
        case "policy-program":
          input.policySnapshot.programId = "other";
          break;
        case "disabled":
          input.policySnapshot.policy.enabled = false;
          break;
        case "journey":
          input.policySnapshot.policy.journey = "birthday";
          break;
      }
      expect(() => createRewardExpiryCommunication(input), change).toThrow();
      if (
        !["policy-store", "policy-program", "disabled", "journey"].includes(
          change,
        )
      ) {
        expect(
          matchesRewardExpiryCommunicationEvidence({
            event,
            receipt,
            now: input.now,
          }),
          change,
        ).toBe(false);
      }
    }
  },
);

it("rejects missing ordinary issuance, ownership, code and stored-value artifacts", () => {
  for (const change of [
    "issuance",
    "ownership",
    "code",
    "gift_card",
    "store_credit",
  ] as const) {
    const input = fixture();
    if (input.receipt.kind !== "redemption") throw new Error("fixture");
    const row = input.receipt.input.redemption;
    if (change === "issuance")
      delete object(row.metadata).rewardCommunicationIssuedAt;
    if (change === "ownership")
      delete object(row.metadata).shopifyDiscountOwnership;
    if (change === "code") row.shopifyDiscountCodeCanonical = "OTHER";
    if (change === "gift_card" || change === "store_credit")
      row.artifactKind = change;
    expect(() => createRewardExpiryCommunication(input), change).toThrow();
  }
});
it("rejects referral points as reward expiry evidence", () => {
  const input = fixture("referral_coupon");
  const { policySnapshot: _policy, ...points } =
    referralBenefitFixture("points");
  input.receipt = { kind: "referral_coupon", input: points };
  expect(() => createRewardExpiryCommunication(input)).toThrow();
});
it.each(["redemption", "referral_coupon"] as const)(
  "strictly binds serialized %s identity and timestamps",
  (kind) => {
    const event = createRewardExpiryCommunication(fixture(kind));
    for (const field of [
      "storeId",
      "programId",
      "accountId",
      "installationGeneration",
      "redemptionId",
    ] as const)
      expect(
        () =>
          rewardExpiryCommunicationSchema.parse({ ...event, [field]: "other" }),
        field,
      ).toThrow();
    expect(() =>
      rewardExpiryCommunicationSchema.parse({
        ...event,
        dueAt: event.expiresAt,
      }),
    ).toThrow();
    expect(() =>
      rewardExpiryCommunicationSchema.parse({
        ...event,
        recipient: "private@example.test",
      }),
    ).toThrow();
    expect(() =>
      rewardExpiryCommunicationSchema.parse({
        ...event,
        receipt: { ...event.receipt, code: "secret" },
      }),
    ).toThrow();
  },
);

it.each(["redemption", "referral_coupon"] as const)(
  "rejects replacement remote artifacts for %s, even with an otherwise valid receipt",
  (kind) => {
    const input = fixture(kind);
    const event = createRewardExpiryCommunication(input);
    if (input.receipt.kind === "redemption")
      input.receipt.input.redemption.shopifyDiscountId = "replacement-id";
    else if (input.receipt.input.receipt.kind === "coupon")
      input.receipt.input.receipt.redemption.shopifyDiscountId =
        "replacement-id";
    expect(
      matchesRewardExpiryCommunicationEvidence({
        event,
        receipt: input.receipt,
        now: input.now,
      }),
    ).toBe(false);
  },
);

it.each(["redemption", "referral_coupon"] as const)(
  "rechecks %s database sources and tenant-bound query scopes",
  async (kind) => {
    for (const failure of [
      "none",
      "missing",
      "used",
      "expired",
      "changed-artifact",
      "missing-source",
      "reversed",
    ] as const) {
      const input = fixture(kind);
      const event = createRewardExpiryCommunication(input);
      const receipt = input.receipt;
      const row =
        receipt.kind === "redemption"
          ? receipt.input.redemption
          : receipt.input.receipt.kind === "coupon"
            ? receipt.input.receipt.redemption
            : null;
      if (!row) throw new Error("fixture");
      const query = vi
        .fn()
        .mockResolvedValue(failure === "missing" ? null : row);
      if (failure === "used") row.status = "used";
      if (failure === "changed-artifact") row.shopifyDiscountId = "replacement";
      const ledger = vi
        .fn()
        .mockResolvedValueOnce(
          failure === "missing-source"
            ? null
            : receipt.kind === "redemption"
              ? receipt.input.ledger
              : null,
        )
        .mockResolvedValueOnce(
          failure === "reversed" ? { id: "compensation" } : null,
        );
      const referral = vi
        .fn()
        .mockResolvedValue(
          failure === "missing-source"
            ? null
            : receipt.kind === "referral_coupon"
              ? receipt.input.referral
              : null,
        );
      const order = vi.fn().mockResolvedValue({
        status: failure === "reversed" ? "refunded" : "paid",
      });
      const db = {
        weleticRewardRedemption: { findFirst: query },
        weleticPointsLedgerEntry: { findFirst: ledger },
        weleticLoyaltyReferral: { findFirst: referral },
        weleticCommerceOrder: { findFirst: order },
      } as unknown as Parameters<typeof isCurrentRewardExpiryReceipt>[0]["db"];
      const result = await isCurrentRewardExpiryReceipt({
        db,
        event,
        now: failure === "expired" ? new Date(event.expiresAt) : input.now,
      });
      expect(result, failure).toBe(failure === "none");
      if (failure === "expired") expect(query).not.toHaveBeenCalled();
      else
        expect(query).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: event.redemptionId,
              storeId: event.storeId,
              accountId: event.accountId,
            },
          }),
        );
      if (failure === "none" && event.receipt.kind === "referral_coupon") {
        expect(order).toHaveBeenCalledWith({
          where: {
            id: event.receipt.evidence.origin.qualificationOrderId,
            storeId: event.storeId,
          },
          select: { status: true },
        });
      }
    }
  },
);
