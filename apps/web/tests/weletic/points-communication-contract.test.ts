import { expect, it } from "vitest";
import {
  createPurchasePointsCommunication,
  purchasePointsCommunicationKey,
  purchasePointsCommunicationSchema,
} from "../../lib/weletic/loyalty/points-communication-contract";

const template = {
  subject: "You earned {{points}}",
  heading: "Points earned",
  body: "View your points",
  actionLabel: "View rewards",
};
const input = () => ({
  storeId: "store",
  programId: "program",
  accountId: "account",
  installationGeneration: "generation",
  ledger: {
    id: "ledger",
    storeId: "store",
    accountId: "account",
    entryType: "EARN_ORDER",
    pointsDelta: BigInt("9007199254740993"),
    referenceType: "COMMERCE_ORDER",
    referenceId: "order",
    createdAt: new Date("2026-09-10T00:00:00Z"),
  },
  policySnapshot: {
    storeId: "store",
    programId: "program",
    revision: "a".repeat(64),
    policy: {
      journey: "points_earned",
      enabled: true,
      templates: { en: template, ja: template, vi: template },
    },
  },
});
it("retains posted provenance separately from reconciled eligible points", () => {
  const event = createPurchasePointsCommunication({
    ...input(),
    eligiblePoints: BigInt(15),
  });
  expect(event.points).toBe("15");
  expect(event.ledgerPoints).toBe("9007199254740993");
});
it.each([BigInt(0), BigInt(-1), BigInt("9007199254740994")])(
  "rejects invalid reconciled amount %s",
  (eligiblePoints) => {
    expect(() =>
      createPurchasePointsCommunication({ ...input(), eligiblePoints }),
    ).toThrow();
  },
);
it.each(["abc", "1.2", "01", "+1", "1e3", "0", "-1", "9".repeat(20)])(
  "rejects malformed decimal %s without throwing from safeParse",
  (points) => {
    expect(
      purchasePointsCommunicationSchema.safeParse({
        ...createPurchasePointsCommunication(input()),
        points,
      }).success,
    ).toBe(false);
  },
);
it("preserves exact immutable posted points and clones the policy", () => {
  const data = input();
  const event = createPurchasePointsCommunication(data);
  expect(event.points).toBe("9007199254740993");
  data.policySnapshot.policy.enabled = false;
  expect(event.policy.enabled).toBe(true);
  expect(event.occurredAt).toBe("2026-09-10T00:00:00.000Z");
});
it.each([
  "ledger-store",
  "ledger-account",
  "policy-store",
  "policy-program",
  "unsupported-entry-type",
  "refund",
  "reference",
])("rejects %s evidence", (kind) => {
  const data = input();
  if (kind === "ledger-store") data.ledger.storeId = "foreign";
  if (kind === "ledger-account") data.ledger.accountId = "foreign";
  if (kind === "policy-store") data.policySnapshot.storeId = "foreign";
  if (kind === "policy-program") data.policySnapshot.programId = "foreign";
  if (kind === "unsupported-entry-type") data.ledger.entryType = "BACKFILL";
  if (kind === "refund") data.ledger.entryType = "REFUND_REVERSAL";
  if (kind === "reference") data.ledger.referenceType = "PENDING_GRANT";
  expect(() => createPurchasePointsCommunication(data)).toThrow();
});
it.each([BigInt(0), BigInt(-1), BigInt("9223372036854775808")])(
  "rejects invalid points %s",
  (points) => {
    const data = input();
    data.ledger.pointsDelta = points;
    expect(() => createPurchasePointsCommunication(data)).toThrow();
  },
);
it("keeps a disabled policy disabled and refuses another journey", () => {
  const data = input();
  data.policySnapshot.policy.enabled = false;
  expect(createPurchasePointsCommunication(data).policy.enabled).toBe(false);
  data.policySnapshot.policy.journey = "birthday";
  expect(() => createPurchasePointsCommunication(data)).toThrow();
});
it.each(["recipient", "email", "url", "sender"])(
  "rejects injected %s",
  (key) => {
    expect(
      purchasePointsCommunicationSchema.safeParse({
        ...createPurchasePointsCommunication(input()),
        [key]: "untrusted",
      }).success,
    ).toBe(false);
  },
);
it("deduplicates policy edits but separates tenants, generations and events", () => {
  const event = createPurchasePointsCommunication(input());
  const key = purchasePointsCommunicationKey(event);
  expect(
    purchasePointsCommunicationKey({
      ...event,
      policyRevision: "b".repeat(64),
    }),
  ).toBe(key);
  for (const field of [
    "storeId",
    "installationGeneration",
    "accountId",
    "ledgerEntryId",
  ] as const) {
    expect(
      purchasePointsCommunicationKey({ ...event, [field]: "different" }),
    ).not.toBe(key);
  }
  expect(key).not.toContain("account");
});
