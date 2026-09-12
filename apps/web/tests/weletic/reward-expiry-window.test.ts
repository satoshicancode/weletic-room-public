import { describe, expect, it } from "vitest";
import {
  isRewardExpiryReminderDue,
  rewardExpiryReminderWindow,
} from "../../lib/weletic/loyalty/reward-expiry-window";

const issuedAt = new Date("2026-09-01T12:00:00Z");
const expiresAt = new Date("2026-09-30T12:00:00Z");

describe("reward expiry reminder window (no delivery authorization)", () => {
  it.each([
    ["2026-09-27T11:59:59.999Z", false],
    ["2026-09-27T12:00:00.000Z", true],
    ["2026-09-29T12:00:00.000Z", true],
    ["2026-09-30T11:59:59.999Z", true],
    ["2026-09-30T12:00:00.000Z", false],
    ["2026-10-01T00:00:00.000Z", false],
  ])("evaluates the exact boundary %s", (now, expected) => {
    expect(
      isRewardExpiryReminderDue({ issuedAt, expiresAt, now: new Date(now) }),
    ).toBe(expected);
  });

  it("never schedules before a short-lived reward was issued", () => {
    const lateIssuedAt = new Date("2026-09-29T12:00:00Z");
    expect(
      rewardExpiryReminderWindow({ issuedAt: lateIssuedAt, expiresAt })?.dueAt,
    ).toEqual(lateIssuedAt);
    expect(
      isRewardExpiryReminderDue({
        issuedAt: lateIssuedAt,
        expiresAt,
        now: new Date("2026-09-28T12:00:00Z"),
      }),
    ).toBe(false);
    expect(
      isRewardExpiryReminderDue({
        issuedAt: lateIssuedAt,
        expiresAt,
        now: lateIssuedAt,
      }),
    ).toBe(true);
  });

  it.each([
    [null, expiresAt],
    [issuedAt, null],
    [new Date(NaN), expiresAt],
    [issuedAt, new Date(NaN)],
    [expiresAt, expiresAt],
    [expiresAt, issuedAt],
  ])("rejects missing or invalid receipt timing %#", (issuedAt, expiresAt) => {
    expect(rewardExpiryReminderWindow({ issuedAt, expiresAt })).toBeNull();
  });

  it("rejects an invalid wall clock", () => {
    expect(
      isRewardExpiryReminderDue({ issuedAt, expiresAt, now: new Date(NaN) }),
    ).toBe(false);
  });

  it("uses the expiry instant across explicit timezone offsets", () => {
    const expiry = new Date("2026-11-02T01:00:00-05:00");
    expect(
      rewardExpiryReminderWindow({
        issuedAt,
        expiresAt: expiry,
      })?.dueAt.toISOString(),
    ).toBe("2026-10-30T06:00:00.000Z");
  });

  it("returns copies so callers cannot mutate receipt evidence", () => {
    const window = rewardExpiryReminderWindow({ issuedAt, expiresAt })!;
    window.expiresAt.setUTCFullYear(2000);
    expect(expiresAt.toISOString()).toBe("2026-09-30T12:00:00.000Z");
  });
});
