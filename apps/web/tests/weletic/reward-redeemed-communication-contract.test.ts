import type { Prisma } from "@prisma/client";
import { expect, it, vi } from "vitest";
import { readRewardCommunicationOrigin } from "../../lib/weletic/loyalty/reward-communication-origin";
import {
  createRewardRedeemedCommunication,
  matchesRewardCommunicationEvidence,
  rewardRedeemedCommunicationJobSchema,
  rewardRedeemedCommunicationKey,
  rewardRedeemedCommunicationSchema,
} from "../../lib/weletic/loyalty/reward-redeemed-communication-contract";
import { isCurrentRewardRedemption } from "../../lib/weletic/loyalty/reward-redeemed-communication-source";
import { createDefaultLoyaltyCommunicationPolicy } from "../../ui/weletic/loyalty/communications-defaults";

import { rewardCommunicationFixture as fixture } from "./reward-communication-fixture";
type Input = ReturnType<typeof fixture>;

it.each([
  "amount_off",
  "percentage_off",
  "free_shipping",
  "free_product",
  "gift_card",
  "store_credit",
])(
  "captures confirmed %s provenance without copying remote secrets",
  (type) => {
    const event = createRewardRedeemedCommunication(fixture(type));
    expect(event).toMatchObject({
      pointsSpent: "9007199254740993",
      redemptionId: "redemption",
      reward: { name: "Original reward", type, currency: "USD" },
    });
    expect(JSON.stringify(event)).not.toContain("private-");
    expect(event).not.toHaveProperty("customerSelectionDigest");
    expect(
      rewardRedeemedCommunicationJobSchema.safeParse({
        ...event,
        communicationDeliverySnapshot: "encrypted",
      }).success,
    ).toBe(true);
    expect(
      rewardRedeemedCommunicationSchema.safeParse({
        ...event,
        communicationDeliverySnapshot: "encrypted",
      }).success,
    ).toBe(false);
  },
);

const rejectCases: Array<[string, (input: Input) => void]> = [
  [
    "reserved but not issued",
    (x) => {
      x.redemption.status = "provisioning";
    },
  ],
  [
    "already used",
    (x) => {
      x.redemption.status = "used";
    },
  ],
  [
    "cancelled",
    (x) => {
      x.redemption.status = "cancelled";
    },
  ],
  [
    "quarantined",
    (x) => {
      x.redemption.settlementQuarantinedAt = new Date();
    },
  ],
  [
    "direct referral award",
    (x) => {
      x.redemption.fulfillmentSource = "referral_friend";
    },
  ],
  [
    "foreign redemption store",
    (x) => {
      x.redemption.storeId = "other";
    },
  ],
  [
    "foreign redemption account",
    (x) => {
      x.redemption.accountId = "other";
    },
  ],
  [
    "foreign ledger account",
    (x) => {
      x.ledger.accountId = "other";
    },
  ],
  [
    "foreign ledger store",
    (x) => {
      x.ledger.storeId = "other";
    },
  ],
  [
    "wrong ledger entry",
    (x) => {
      x.redemption.ledgerEntryId = "other";
    },
  ],
  [
    "manual debit",
    (x) => {
      x.ledger.entryType = "MANUAL_ADJUSTMENT";
    },
  ],
  [
    "wrong reference",
    (x) => {
      x.ledger.referenceId = "other";
    },
  ],
  [
    "wrong debit",
    (x) => {
      x.ledger.pointsDelta += BigInt(1);
    },
  ],
  [
    "zero cost",
    (x) => {
      x.redemption.pointsSpent = BigInt(0);
      x.ledger.pointsDelta = BigInt(0);
    },
  ],
  [
    "snapshot reward mismatch",
    (x) => {
      x.redemption.rewardDefinitionId = "other";
    },
  ],
  [
    "missing snapshot",
    (x) => {
      x.redemption.metadata = {};
    },
  ],
  [
    "wrong artifact kind",
    (x) => {
      x.redemption.artifactKind = "gift_card";
    },
  ],
  [
    "missing remote identity",
    (x) => {
      x.redemption.shopifyDiscountId = null;
    },
  ],
  [
    "foreign policy store",
    (x) => {
      x.policySnapshot.storeId = "other";
    },
  ],
  [
    "foreign policy program",
    (x) => {
      x.policySnapshot.programId = "other";
    },
  ],
  [
    "different journey",
    (x) => {
      x.policySnapshot.policy =
        createDefaultLoyaltyCommunicationPolicy("birthday");
    },
  ],
  [
    "issuance before reservation",
    (x) => {
      x.occurredAt = new Date("2026-09-11T00:00:00Z");
    },
  ],
];
it.each(rejectCases)("rejects %s", (_label, mutate) => {
  const input = fixture();
  mutate(input);
  expect(() => createRewardRedeemedCommunication(input)).toThrow();
});
it("rejects edited financial snapshot content", () => {
  const input = fixture();
  const metadata = input.redemption.metadata as {
    provisioningSnapshot: { discountValue: string };
  };
  metadata.provisioningSnapshot.discountValue = "99";
  expect(() => createRewardRedeemedCommunication(input)).toThrow();
});
it("normalizes legacy header controls without modifying financial evidence", () => {
  const input = fixture("amount_off", "Original\r\nreward");
  const before = JSON.stringify(input.redemption.metadata);
  expect(createRewardRedeemedCommunication(input).reward.name).toBe(
    "Original reward",
  );
  expect(JSON.stringify(input.redemption.metadata)).toBe(before);
});
it("keys one issuance independently of template edits or retry time", () => {
  const event = createRewardRedeemedCommunication(fixture());
  expect(
    rewardRedeemedCommunicationKey({
      ...event,
      occurredAt: "2026-09-12T00:02:00.000Z",
      policyRevision: "b".repeat(64),
    }),
  ).toBe(rewardRedeemedCommunicationKey(event));
  for (const field of [
    "storeId",
    "accountId",
    "installationGeneration",
    "redemptionId",
  ] as const)
    expect(
      rewardRedeemedCommunicationKey({ ...event, [field]: "other" }),
    ).not.toBe(rewardRedeemedCommunicationKey(event));
});
it.each(["email", "discountCode", "customerId", "url"])(
  "rejects injected %s",
  (field) => {
    expect(
      rewardRedeemedCommunicationSchema.safeParse({
        ...createRewardRedeemedCommunication(fixture()),
        [field]: "private",
      }).success,
    ).toBe(false);
  },
);

it.each(["gift_card", "store_credit"])(
  "rejects missing %s issuance identity",
  (type) => {
    const input = fixture(type);
    input.redemption.shopifyGiftCardId = null;
    input.redemption.shopifyStoreCreditTransactionId = null;
    expect(() => createRewardRedeemedCommunication(input)).toThrow();
  },
);
it("rejects the wrong ledger reference type", () => {
  const input = fixture();
  input.ledger.referenceType = "MANUAL";
  expect(() => createRewardRedeemedCommunication(input)).toThrow();
});
it("rejects matching debit and redemption when the captured cost differs", () => {
  const input = fixture();
  input.redemption.pointsSpent += BigInt(1);
  input.ledger.pointsDelta = -input.redemption.pointsSpent;
  expect(() => createRewardRedeemedCommunication(input)).toThrow();
});
it("preserves the signed-bigint boundary and rejects overflow", () => {
  expect(
    createRewardRedeemedCommunication(
      fixture("amount_off", "Reward", "9223372036854775807"),
    ).pointsSpent,
  ).toBe("9223372036854775807");
  expect(() =>
    createRewardRedeemedCommunication(
      fixture("amount_off", "Reward", "9223372036854775808"),
    ),
  ).toThrow();
});
it.each(["occurrence", "ledger"])("rejects invalid %s dates", (kind) => {
  const input = fixture();
  if (kind === "occurrence") input.occurredAt = new Date("invalid");
  else input.ledger.createdAt = new Date("invalid");
  expect(() => createRewardRedeemedCommunication(input)).toThrow();
});

it.each(["issued", "active", "used"])(
  "keeps frozen issuance evidence through %s progression",
  (status) => {
    const input = fixture();
    const event = createRewardRedeemedCommunication(input);
    input.redemption.status = status;
    expect(
      matchesRewardCommunicationEvidence({
        event: { ...event, communicationDeliverySnapshot: "encrypted" },
        redemption: input.redemption,
        ledger: input.ledger,
      }),
    ).toBe(true);
  },
);
it.each(["cancelled", "failed", "expired", "provisioning"])(
  "suppresses %s during delivery recheck",
  (status) => {
    const input = fixture();
    const event = createRewardRedeemedCommunication(input);
    input.redemption.status = status;
    expect(
      matchesRewardCommunicationEvidence({
        event,
        redemption: input.redemption,
        ledger: input.ledger,
      }),
    ).toBe(false);
  },
);
it("does not accept edited event display terms against the frozen financial source", () => {
  const input = fixture();
  const event = createRewardRedeemedCommunication(input);
  event.reward.value = "999";
  expect(
    matchesRewardCommunicationEvidence({
      event,
      redemption: input.redemption,
      ledger: input.ledger,
    }),
  ).toBe(false);
});
it.each(["eligible", "compensated", "expired", "future", "missing"])(
  "checks scoped source eligibility: %s",
  async (state) => {
    const input = fixture();
    const event = createRewardRedeemedCommunication(input);
    const redemption = vi.fn().mockResolvedValue(
      state === "missing"
        ? null
        : {
            ...input.redemption,
            expiresAt:
              state === "expired" ? new Date("2026-09-12T00:02:00Z") : null,
          },
    );
    const ledger = vi
      .fn()
      .mockResolvedValueOnce(input.ledger)
      .mockResolvedValueOnce(state === "compensated" ? { id: "refund" } : null);
    const db = {
      weleticRewardRedemption: { findFirst: redemption },
      weleticPointsLedgerEntry: { findFirst: ledger },
    } as unknown as Prisma.TransactionClient;
    expect(
      await isCurrentRewardRedemption({
        db,
        event,
        now: new Date(
          state === "future" ? "2026-09-12T00:00:00Z" : "2026-09-12T00:03:00Z",
        ),
      }),
    ).toBe(state === "eligible");
    if (state !== "future")
      expect(redemption).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "redemption", storeId: "store", accountId: "account" },
        }),
      );
    if (state === "eligible" || state === "compensated")
      expect(ledger).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            storeId: "store",
            accountId: "account",
            referenceType: "REDEMPTION_REFUND",
            referenceId: "redemption",
            pointsDelta: { gt: BigInt(0) },
          },
        }),
      );
  },
);

it("does not bind a legacy reservation to the current installation", () => {
  const input = fixture();
  const metadata = input.redemption.metadata as Record<string, unknown>;
  delete metadata.rewardCommunicationOrigin;
  expect(
    readRewardCommunicationOrigin({
      metadata,
      storeId: "store",
      accountId: "account",
      redemptionId: "redemption",
      provisioningDigest: "A".repeat(64),
    }),
  ).toBeNull();
  expect(() => createRewardRedeemedCommunication(input)).toThrow();
});
it.each([
  "storeId",
  "accountId",
  "redemptionId",
  "provisioningDigest",
  "installationGeneration",
])("rejects mismatched origin %s", (field) => {
  const input = fixture();
  const metadata = input.redemption.metadata as {
    rewardCommunicationOrigin: Record<string, unknown>;
  };
  metadata.rewardCommunicationOrigin[field] = "other";
  expect(() => createRewardRedeemedCommunication(input)).toThrow();
});
it("rejects malformed origin instead of treating it as a legacy record", () => {
  expect(() =>
    readRewardCommunicationOrigin({
      metadata: { rewardCommunicationOrigin: null },
      storeId: "store",
      accountId: "account",
      redemptionId: "redemption",
      provisioningDigest: "A".repeat(64),
    }),
  ).toThrow();
});
