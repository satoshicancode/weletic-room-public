import { expect, it } from "vitest";
import {
  birthdayCommunicationJobSchema,
  birthdayCommunicationKey,
  birthdayCommunicationSchema,
  createBirthdayCommunication,
} from "../../lib/weletic/loyalty/birthday-communication-contract";

const input = () => {
  const template = {
    subject: "Happy birthday",
    heading: "Celebrate",
    body: "{{points}} {{points_label}}",
    actionLabel: "View",
  };
  return {
    storeId: "store",
    programId: "program",
    accountId: "account",
    installationGeneration: "g1",
    calendarYear: 2026,
    ledger: {
      id: "ledger",
      storeId: "store",
      accountId: "account",
      entryType: "EARN_BONUS" as const,
      referenceType: "BIRTHDAY_REWARD",
      referenceId: "2026",
      idempotencyKey: "birthday:account:2026",
      grantId: null as string | null,
      pointsDelta: BigInt("9007199254740993"),
      createdAt: new Date("2026-09-10T00:00:00Z"),
    },
    policySnapshot: {
      storeId: "store",
      programId: "program",
      revision: "a".repeat(64),
      policy: {
        journey: "birthday",
        enabled: true,
        templates: { en: template, ja: template, vi: template },
      },
    },
  };
};
it("retains exact annual evidence and clones policy without profile or order data", () => {
  const data = input();
  const event = createBirthdayCommunication(data);
  data.policySnapshot.policy.enabled = false;
  expect(event.points).toBe("9007199254740993");
  expect(event.policy.enabled).toBe(true);
  expect(event.calendarYear).toBe(2026);
  expect(event).not.toHaveProperty("birthDate");
  expect(event).not.toHaveProperty("orderId");
  expect(
    birthdayCommunicationJobSchema.safeParse({
      ...event,
      communicationDeliverySnapshot: "encrypted",
    }).success,
  ).toBe(true);
});
it.each([
  "store",
  "account",
  "year",
  "key",
  "grant",
  "reference",
  "policy-store",
  "policy-program",
  "journey",
])("rejects mismatched %s provenance", (kind) => {
  const data = input();
  if (kind === "store") data.ledger.storeId = "foreign";
  if (kind === "account") data.ledger.accountId = "foreign";
  if (kind === "year") data.calendarYear++;
  if (kind === "key") data.ledger.idempotencyKey = "signup:account";
  if (kind === "grant") data.ledger.grantId = "purchase-grant";
  if (kind === "reference") data.ledger.referenceType = "SIGNUP_BONUS";
  if (kind === "policy-store") data.policySnapshot.storeId = "foreign";
  if (kind === "policy-program") data.policySnapshot.programId = "foreign";
  if (kind === "journey") data.policySnapshot.policy.journey = "points_earned";
  expect(() => createBirthdayCommunication(data)).toThrow();
});
it.each(["abc", "1.2", "01", "0", "-1", "9223372036854775808"])(
  "rejects unsafe points %s without throwing from safeParse",
  (points) => {
    expect(
      birthdayCommunicationSchema.safeParse({
        ...createBirthdayCommunication(input()),
        points,
        ledgerPoints: points,
      }).success,
    ).toBe(false);
  },
);
it.each(["birthDate", "email", "orderId"])("rejects injected %s", (field) => {
  expect(
    birthdayCommunicationSchema.safeParse({
      ...createBirthdayCommunication(input()),
      [field]: "unexpected",
    }).success,
  ).toBe(false);
});
it("does not change event identity on policy edits but separates installations", () => {
  const event = createBirthdayCommunication(input());
  expect(birthdayCommunicationKey(event)).toBe(
    birthdayCommunicationKey({ ...event, policyRevision: "b".repeat(64) }),
  );
  expect(birthdayCommunicationKey(event)).not.toBe(
    birthdayCommunicationKey({ ...event, installationGeneration: "g2" }),
  );
});
it("rejects an announced amount different from its ledger amount", () => {
  expect(
    birthdayCommunicationJobSchema.safeParse({
      ...createBirthdayCommunication(input()),
      points: "1",
    }).success,
  ).toBe(false);
});
