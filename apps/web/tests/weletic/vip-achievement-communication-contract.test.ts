import { expect, it } from "vitest";
import {
  createVipAchievementCommunication,
  vipAchievementCommunicationJobSchema,
  vipAchievementCommunicationKey,
  vipAchievementCommunicationSchema,
} from "../../lib/weletic/loyalty/vip-achievement-communication-contract";
import { createDefaultLoyaltyCommunicationPolicy } from "../../ui/weletic/loyalty/communications-defaults";

function fixture(): Parameters<typeof createVipAchievementCommunication>[0] {
  return {
    storeId: "store",
    programId: "program",
    accountId: "account",
    installationGeneration: "generation",
    history: {
      id: "history",
      accountId: "account",
      sequenceNumber: 3,
      fromTierId: "silver",
      toTierId: "gold",
      changeReason: "threshold_reached",
      effectiveAt: new Date("2026-09-10T00:00:00Z"),
    },
    fromTier: { id: "silver", storeId: "store", programId: "program", rank: 1 },
    toTier: {
      id: "gold",
      storeId: "store",
      programId: "program",
      rank: 2,
      name: "Gold",
    },
    policySnapshot: {
      storeId: "store",
      programId: "program",
      revision: "a".repeat(64),
      policy: {
        ...createDefaultLoyaltyCommunicationPolicy("vip_achieved"),
        enabled: true,
      },
    },
  };
}
it("retains exact promotion history and no financial or recipient placeholders", () => {
  const event = createVipAchievementCommunication(fixture());
  expect(event).toMatchObject({
    source: "vip_threshold_promotion",
    sequenceNumber: 3,
    tierHistoryId: "history",
    toTier: { id: "gold", rank: 2, name: "Gold" },
  });
  for (const key of [
    "email",
    "birthDate",
    "points",
    "ledgerEntryId",
    "orderId",
    "rewardId",
  ])
    expect(event).not.toHaveProperty(key);
  expect(
    vipAchievementCommunicationJobSchema.safeParse({
      ...event,
      communicationDeliverySnapshot: "encrypted",
    }).success,
  ).toBe(true);
  expect(
    vipAchievementCommunicationSchema.safeParse({
      ...event,
      communicationDeliverySnapshot: "encrypted",
    }).success,
  ).toBe(false);
});
it.each(["annual_downgrade", "manual_adjustment", "import", ""])(
  "rejects non-achievement history %s",
  (reason) => {
    const input = fixture();
    input.history.changeReason = reason;
    expect(() => createVipAchievementCommunication(input)).toThrow(
      "VIP achievement evidence unavailable",
    );
  },
);
it.each([null, 0, -1, 1.5, 2_147_483_648, NaN, Infinity])(
  "rejects invalid history sequence %s",
  (sequence) => {
    const input = fixture();
    input.history.sequenceNumber = sequence;
    expect(() => createVipAchievementCommunication(input)).toThrow();
  },
);
it.each(["fromTier", "toTier", "policySnapshot"] as const)(
  "rejects foreign ownership in %s",
  (key) => {
    for (const field of ["storeId", "programId"] as const) {
      const input = fixture();
      input[key][field] = "foreign";
      expect(() => createVipAchievementCommunication(input)).toThrow(
        "VIP achievement evidence unavailable",
      );
    }
  },
);
it.each(["accountId", "fromTierId", "toTierId"] as const)(
  "rejects history mismatch %s",
  (key) => {
    const input = fixture();
    input.history[key] = "foreign";
    expect(() => createVipAchievementCommunication(input)).toThrow(
      "VIP achievement evidence unavailable",
    );
  },
);
it.each([0, 1, -1, 1.5, Infinity])(
  "rejects non-promoting or invalid rank %s",
  (rank) => {
    const input = fixture();
    input.toTier.rank = rank;
    expect(() => createVipAchievementCommunication(input)).toThrow();
  },
);
it.each(["", " ", "x".repeat(192)])(
  "rejects unsafe or empty tier name %j",
  (name) => {
    const input = fixture();
    input.toTier.name = name;
    expect(() => createVipAchievementCommunication(input)).toThrow();
  },
);
it.each(["ゴールド", "Hạng Vàng", "Gold"])(
  "preserves the exact tier name %s",
  (name) => {
    const input = fixture();
    input.toTier.name = name;
    expect(createVipAchievementCommunication(input).toTier.name).toBe(name);
  },
);
it.each([
  ["Gold\nMembers", "Gold Members"],
  ["\tGold", "Gold"],
  ["Gold\u0000", "Gold"],
  [" Gold ", "Gold"],
  ["\u0000", "VIP"],
  ["Gold\u2028Members", "Gold Members"],
])("normalizes only the captured message label %j", (name, expected) => {
  const input = fixture();
  input.toTier.name = name;
  expect(createVipAchievementCommunication(input).toTier.name).toBe(expected);
  expect(input.toTier.name).toBe(name);
});
it.each(["Gold\nMembers", "Gold\u0000", "Gold\u2028Members"])(
  "rejects controls injected directly into an event %j",
  (name) => {
    const event = createVipAchievementCommunication(fixture());
    expect(
      vipAchievementCommunicationSchema.safeParse({
        ...event,
        toTier: { ...event.toTier, name },
      }).success,
    ).toBe(false);
  },
);
it.each(["email", "birthDate", "points", "orderId", "ledgerEntryId"])(
  "rejects injected %s",
  (field) => {
    const event = createVipAchievementCommunication(fixture());
    expect(
      vipAchievementCommunicationSchema.safeParse({
        ...event,
        [field]: "injected",
      }).success,
    ).toBe(false);
  },
);
it("rejects another journey's policy", () => {
  const input = fixture();
  input.policySnapshot.policy =
    createDefaultLoyaltyCommunicationPolicy("points_earned");
  expect(() => createVipAchievementCommunication(input)).toThrow();
});
it("keeps retry identity stable across content edits but separates generations and new transitions", () => {
  const original = createVipAchievementCommunication(fixture());
  const key = vipAchievementCommunicationKey(original);
  expect(
    vipAchievementCommunicationKey({
      ...original,
      toTier: { ...original.toTier, name: "Renamed" },
      policyRevision: "b".repeat(64),
    }),
  ).toBe(key);
  expect(
    vipAchievementCommunicationKey({
      ...original,
      installationGeneration: "new",
    }),
  ).not.toBe(key);
  expect(
    vipAchievementCommunicationKey({
      ...original,
      tierHistoryId: "requalified",
      sequenceNumber: 5,
    }),
  ).not.toBe(key);
});
