import {
  defaultReviewCollectionPolicy,
  reviewCollectionPolicySchema,
  reviewCollectionWriteInputSchema,
} from "@/lib/weletic/reviews/collection-contract";
import { reviewSettingsSchema } from "@/lib/weletic/reviews/contracts";
import {
  planReviewReminders,
  snapshotReviewReminderSchedule,
} from "@/lib/weletic/reviews/reminder-schedule";
import { describe, expect, it } from "vitest";

describe("review collection contracts and prospective reminders", () => {
  const policy = {
    ...defaultReviewCollectionPolicy(),
    requestEmailEnabled: true,
    reminderAfterDays: [3, 7, 14],
  };
  it("defaults to no sends or reminders and returns independent defaults", () => {
    const first = defaultReviewCollectionPolicy();
    first.reminderAfterDays.push(3);
    expect(defaultReviewCollectionPolicy()).toMatchObject({
      requestEmailEnabled: false,
      reminderAfterDays: [],
    });
  });
  it.each([[0], [1.5], [3, 3], [7, 3], [30], [1, 2, 3, 4], [-1]])(
    "rejects invalid reminder sequence %j",
    (...days) => {
      expect(
        reviewCollectionPolicySchema.safeParse({
          ...policy,
          reminderAfterDays: days,
        }).success,
      ).toBe(false);
    },
  );
  it.each(["enabled", "activeIncentivePolicyId", "storeId", "token"])(
    "rejects unrelated collection authority %s",
    (key) => {
      expect(
        reviewCollectionPolicySchema.safeParse({ ...policy, [key]: true })
          .success,
      ).toBe(false);
    },
  );
  it("requires revision and installation fences, rejecting overflow", () => {
    const input = {
      expectedRevision: 0,
      expectedInstallationGeneration: "g1",
      policy,
    };
    expect(reviewCollectionWriteInputSchema.parse(input)).toEqual(input);
    for (const patch of [
      { expectedRevision: undefined },
      { expectedRevision: -1 },
      { expectedRevision: 2147483647 },
      { expectedInstallationGeneration: "" },
      { expectedInstallationGeneration: undefined },
    ])
      expect(
        reviewCollectionWriteInputSchema.safeParse({ ...input, ...patch })
          .success,
      ).toBe(false);
  });
  it("keeps the existing legacy settings contract unchanged", () => {
    const { reminderAfterDays: _reminders, ...legacy } = policy;
    expect(reviewSettingsSchema.parse({ enabled: false, ...legacy })).toEqual({
      enabled: false,
      ...legacy,
    });
    expect(
      reviewSettingsSchema.safeParse({ enabled: false, ...policy }).success,
    ).toBe(false);
  });
  it("copies prospective offsets without retaining mutable editor state", () => {
    const draft = { ...policy, reminderAfterDays: [3, 7] };
    const saved = snapshotReviewReminderSchedule(draft, 4);
    draft.reminderAfterDays[0] = 1;
    expect(saved).toEqual({
      version: 1,
      collectionRevision: 4,
      expiresAfterDays: 30,
      reminderAfterDays: [3, 7],
    });
    expect(
      snapshotReviewReminderSchedule(
        { ...policy, requestEmailEnabled: false },
        4,
      ).reminderAfterDays,
    ).toEqual([]);
  });
  it("uses initial confirmed delivery time and preserves original expiry", () => {
    const saved = snapshotReviewReminderSchedule(policy, 1);
    expect(
      planReviewReminders({
        snapshot: saved,
        sentAt: new Date("2026-09-20T12:00:00.000Z"),
        expiresAt: new Date("2026-09-27T12:00:00.000Z"),
      }),
    ).toEqual([{ sequence: 1, dueAt: new Date("2026-09-23T12:00:00.000Z") }]);
  });
  it("does not invent a historical schedule or send after expiry", () => {
    const dates = {
      sentAt: new Date("2026-10-01T00:00:00.000Z"),
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    };
    expect(planReviewReminders({ snapshot: null, ...dates })).toEqual([]);
    expect(
      planReviewReminders({
        snapshot: snapshotReviewReminderSchedule(policy, 1),
        ...dates,
      }),
    ).toEqual([]);
  });
  it("rejects corrupted snapshots and invalid timestamps", () => {
    const saved = snapshotReviewReminderSchedule(policy, 1);
    const dates = { sentAt: new Date(0), expiresAt: new Date(8640000000) };
    for (const snapshot of [
      { ...saved, reminderAfterDays: [2, 1] },
      { ...saved, reminderAfterDays: [30] },
      { ...saved, recipient: "private@example.test" },
      { ...saved, version: 2 },
    ])
      expect(() => planReviewReminders({ snapshot, ...dates })).toThrow();
    expect(() =>
      planReviewReminders({
        snapshot: saved,
        ...dates,
        sentAt: new Date(NaN),
      }),
    ).toThrow("Invalid review reminder dates");
  });
});
