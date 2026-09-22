import {
  evaluateShopperDelivery,
  shopperDeliveryPolicySchema,
  type ShopperDeliveryPolicy,
} from "@/lib/weletic/merchant-settings/delivery-policy";
import { describe, expect, it } from "vitest";

const policy: ShopperDeliveryPolicy = {
  version: 1,
  quietHours: { startMinute: 22 * 60, endMinute: 8 * 60 },
  maxMessagesPer24Hours: 2,
};
const evaluate = (
  input: Partial<Parameters<typeof evaluateShopperDelivery>[0]> = {},
) =>
  evaluateShopperDelivery({
    policy,
    timeZone: "UTC",
    paused: false,
    now: new Date("2026-09-22T12:00:00.000Z"),
    expiresAt: null,
    countedReservationTimes: [],
    ...input,
  });

describe("shared shopper delivery scheduling", () => {
  it("does not impose policy when explicitly unconfigured", () => {
    expect(evaluate({ policy: null, timeZone: null })).toEqual({
      status: "eligible",
    });
    expect(evaluate({ policy: null, paused: true })).toEqual({
      status: "blocked",
      reason: "paused",
    });
  });

  it.each([undefined, {}, { ...policy, version: 2 }])(
    "blocks malformed persisted configuration %j",
    (value) => {
      expect(evaluate({ policy: value })).toEqual({
        status: "blocked",
        reason: "configuration_unavailable",
      });
    },
  );

  it.each([null, "Tokyo", "Not/AZone", "+09:00"])(
    "does not infer timezone %s",
    (timeZone) => {
      expect(evaluate({ timeZone })).toEqual({
        status: "blocked",
        reason: "configuration_unavailable",
      });
    },
  );

  it.each([
    ["2026-09-22T21:59:59.999Z", null],
    ["2026-09-22T22:00:00.000Z", "2026-09-23T08:00:00.000Z"],
    ["2026-09-23T07:59:59.999Z", "2026-09-23T08:00:00.000Z"],
    ["2026-09-23T08:00:00.000Z", null],
  ])("honors cross-midnight boundaries at %s", (now, retryAt) => {
    expect(evaluate({ now: new Date(now) })).toEqual(
      retryAt
        ? { status: "deferred", retryAt: new Date(retryAt) }
        : { status: "eligible" },
    );
  });

  it.each([
    ["America/New_York", "2026-03-08T06:45:00Z", "2026-03-08T07:00:00Z"],
    ["America/New_York", "2026-11-01T05:45:00Z", "2026-11-01T07:30:00Z"],
    ["America/New_York", "2026-11-01T06:45:00Z", "2026-11-01T07:30:00Z"],
  ])("handles skipped/repeated hours in %s at %s", (timeZone, now, next) => {
    expect(
      evaluate({
        timeZone,
        now: new Date(now),
        policy: {
          ...policy,
          quietHours: { startMinute: 60, endMinute: 150 },
        },
      }),
    ).toEqual({ status: "deferred", retryAt: new Date(next) });
  });

  it("handles a half-hour DST jump", () => {
    expect(
      evaluate({
        timeZone: "Australia/Lord_Howe",
        now: new Date("2026-10-03T15:15:00Z"),
        policy: {
          ...policy,
          quietHours: { startMinute: 60, endMinute: 135 },
        },
      }),
    ).toEqual({
      status: "deferred",
      retryAt: new Date("2026-10-03T15:30:00Z"),
    });
  });

  it("uses quarter-hour timezone offsets without rounding", () => {
    expect(
      evaluate({
        timeZone: "Asia/Kathmandu",
        now: new Date("2026-09-22T17:00:12.123Z"),
      }),
    ).toEqual({
      status: "deferred",
      retryAt: new Date("2026-09-23T02:15:00Z"),
    });
  });

  it("counts the combined rolling budget, including excess after a limit reduction", () => {
    expect(
      evaluate({
        countedReservationTimes: [
          new Date("2026-09-21T13:00:00Z"),
          new Date("2026-09-21T14:00:00Z"),
          new Date("2026-09-21T15:00:00Z"),
        ],
      }),
    ).toEqual({
      status: "deferred",
      retryAt: new Date("2026-09-22T14:00:00Z"),
    });
  });

  it("excludes reservations at the exact elapsed 24-hour boundary", () => {
    expect(
      evaluate({
        countedReservationTimes: [
          new Date("2026-09-21T12:00:00Z"),
          new Date("2026-09-21T12:00:00.001Z"),
        ],
      }),
    ).toEqual({ status: "eligible" });
  });

  it("applies quiet hours after the capacity release time", () => {
    expect(
      evaluate({
        policy: { ...policy, maxMessagesPer24Hours: 1 },
        countedReservationTimes: [new Date("2026-09-21T23:00:00Z")],
      }),
    ).toEqual({
      status: "deferred",
      retryAt: new Date("2026-09-23T08:00:00Z"),
    });
  });

  it("keeps elapsed-time frequency limits through DST", () => {
    expect(
      evaluate({
        policy: { ...policy, quietHours: null, maxMessagesPer24Hours: 1 },
        timeZone: "America/New_York",
        now: new Date("2026-11-01T16:00:00Z"),
        countedReservationTimes: [new Date("2026-10-31T16:30:00Z")],
      }),
    ).toEqual({
      status: "deferred",
      retryAt: new Date("2026-11-01T16:30:00Z"),
    });
  });

  it("fails closed on future capacity evidence", () => {
    expect(
      evaluate({ countedReservationTimes: [new Date("2026-09-23T12:00Z")] }),
    ).toEqual({ status: "blocked", reason: "configuration_unavailable" });
  });

  it.each(["2026-09-22T12:00:00Z", "2026-09-22T13:00:00Z"])(
    "never extends original expiry %s",
    (expiresAt) => {
      expect(
        evaluate({
          expiresAt: new Date(expiresAt),
          policy: { ...policy, maxMessagesPer24Hours: 1 },
          countedReservationTimes: [new Date("2026-09-21T13:00:00Z")],
        }),
      ).toEqual({ status: "expired" });
    },
  );

  it("does not extend expiry while leaving quiet hours", () => {
    expect(
      evaluate({
        now: new Date("2026-09-22T23:00:00Z"),
        expiresAt: new Date("2026-09-23T08:00:00Z"),
      }),
    ).toEqual({ status: "expired" });
  });

  it("preserves distinct reservations at equal timestamps and millisecond release", () => {
    expect(
      evaluate({
        countedReservationTimes: [
          new Date("2026-09-21T15:00:00Z"),
          new Date("2026-09-21T14:00:00.123Z"),
          new Date("2026-09-21T14:00:00.123Z"),
        ],
        expiresAt: new Date("2026-09-22T14:00:00.124Z"),
      }),
    ).toEqual({
      status: "deferred",
      retryAt: new Date("2026-09-22T14:00:00.123Z"),
    });
  });

  it("supports same-day quiet hours and one-minute delivery windows", () => {
    expect(
      evaluate({
        policy: {
          ...policy,
          quietHours: { startMinute: 0, endMinute: 1439 },
        },
      }),
    ).toEqual({
      status: "deferred",
      retryAt: new Date("2026-09-22T23:59:00Z"),
    });
  });

  it("allows the first eligible repeated-hour instant, then rechecks after fallback", () => {
    const input = {
      timeZone: "America/New_York",
      policy: {
        ...policy,
        quietHours: { startMinute: 90, endMinute: 105 },
      },
    };
    expect(
      evaluate({ ...input, now: new Date("2026-11-01T05:40:00Z") }),
    ).toEqual({
      status: "deferred",
      retryAt: new Date("2026-11-01T05:45:00Z"),
    });
    expect(
      evaluate({ ...input, now: new Date("2026-11-01T05:45:00Z") }),
    ).toEqual({
      status: "eligible",
    });
    expect(
      evaluate({ ...input, now: new Date("2026-11-01T06:40:00Z") }),
    ).toEqual({
      status: "deferred",
      retryAt: new Date("2026-11-01T06:45:00Z"),
    });
  });

  it("blocks an overflowing release timestamp instead of returning an invalid retry", () => {
    expect(
      evaluate({
        now: new Date(8_640_000_000_000_000),
        policy: { ...policy, quietHours: null, maxMessagesPer24Hours: 1 },
        countedReservationTimes: [new Date(8_640_000_000_000_000)],
      }),
    ).toEqual({ status: "blocked", reason: "configuration_unavailable" });
  });

  it.each([
    { now: new Date(NaN) },
    { expiresAt: new Date(NaN) },
    { countedReservationTimes: [new Date(NaN)] },
  ])("rejects invalid date evidence before returning eligibility", (input) => {
    expect(() => evaluate(input)).toThrow("Invalid delivery timestamp");
  });

  it.each([
    { ...policy, quietHours: { startMinute: 0, endMinute: 0 } },
    { ...policy, quietHours: { startMinute: -1, endMinute: 60 } },
    { ...policy, quietHours: { startMinute: 0, endMinute: 1440 } },
    { ...policy, quietHours: { startMinute: 0.5, endMinute: 60 } },
    { ...policy, maxMessagesPer24Hours: 0 },
    { ...policy, maxMessagesPer24Hours: 101 },
    { ...policy, maxMessagesPer24Hours: 1.5 },
    { ...policy, maxMessagesPer24Hours: "2" },
    { ...policy, module: "loyalty" },
  ])("rejects ambiguous or unsupported policy %j", (value) => {
    expect(shopperDeliveryPolicySchema.safeParse(value).success).toBe(false);
  });
});
