import { z } from "zod";
import { merchantTimeZoneSchema } from "./contracts";

const minuteOfDay = z.number().int().min(0).max(1439);

/** One policy for all shopper-email producers; null means unconfigured.
 * The rolling window measures elapsed time, independently of local DST. */
export const shopperDeliveryPolicySchema = z
  .object({
    version: z.literal(1),
    quietHours: z
      .object({ startMinute: minuteOfDay, endMinute: minuteOfDay })
      .strict()
      .refine((value) => value.startMinute !== value.endMinute, {
        message: "Quiet hours must leave a delivery window",
      })
      .nullable(),
    maxMessagesPer24Hours: z.number().int().min(1).max(100).nullable(),
  })
  .strict();

export type ShopperDeliveryPolicy = z.infer<typeof shopperDeliveryPolicySchema>;

export const SHOPPER_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

export type ShopperDeliveryDecision =
  | { status: "eligible" }
  | {
      status: "blocked";
      reason:
        | "paused"
        | "configuration_unavailable"
        | "no_window_before_expiry";
    }
  | { status: "expired" }
  | { status: "deferred"; retryAt: Date };

function timestamp(date: Date) {
  const value = date.getTime();
  if (!Number.isFinite(value)) throw new Error("Invalid delivery timestamp");
  return value;
}

function localMinute(formatter: Intl.DateTimeFormat, instant: number) {
  const parts = formatter.formatToParts(new Date(instant));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute))
    throw new Error("Local delivery time unavailable");
  return hour * 60 + minute;
}

function isQuiet(
  minute: number,
  hours: NonNullable<ShopperDeliveryPolicy["quietHours"]>,
) {
  return hours.startMinute < hours.endMinute
    ? minute >= hours.startMinute && minute < hours.endMinute
    : minute >= hours.startMinute || minute < hours.endMinute;
}

/** Pure scheduling calculation, NOT authorization or capacity reservation.
 * Callers must read counted reservations under the same durable lock as their
 * insert, preserve provider retry fences, and recheck this decision at dispatch.
 * Include uncertain transport attempts in counted reservations. A retry may
 * omit only its own already-reserved slot, never another message's slot. */
export function evaluateShopperDelivery({
  policy,
  timeZone,
  paused,
  now,
  expiresAt,
  countedReservationTimes,
}: {
  policy: unknown;
  timeZone: string | null;
  paused: boolean;
  now: Date;
  expiresAt: Date | null;
  countedReservationTimes: readonly Date[];
}): ShopperDeliveryDecision {
  const start = timestamp(now);
  const expiry = expiresAt ? timestamp(expiresAt) : Infinity;
  if (start >= expiry) return { status: "expired" };
  if (paused) return { status: "blocked", reason: "paused" };
  if (policy === null) return { status: "eligible" };
  const parsed = shopperDeliveryPolicySchema.safeParse(policy);
  // Missing/invalid persisted policy is different from explicit unconfigured.
  if (!parsed.success)
    return { status: "blocked", reason: "configuration_unavailable" };
  const { quietHours, maxMessagesPer24Hours } = parsed.data;
  // Every configured policy requires the store's explicit zone, including a
  // frequency-only policy, so enabling quiet hours cannot infer one later.
  const zone = merchantTimeZoneSchema.safeParse(timeZone);
  if (!zone.success)
    return { status: "blocked", reason: "configuration_unavailable" };

  let candidate = start;
  if (maxMessagesPer24Hours !== null) {
    const reservations = countedReservationTimes.map(timestamp);
    // A future reservation is inconsistent evidence, not spare capacity.
    if (reservations.some((at) => at > start))
      return { status: "blocked", reason: "configuration_unavailable" };
    const active = reservations
      .filter((at) => at > start - SHOPPER_DELIVERY_WINDOW_MS)
      .sort((a, b) => a - b);
    if (active.length >= maxMessagesPer24Hours)
      candidate =
        active[active.length - maxMessagesPer24Hours] +
        SHOPPER_DELIVERY_WINDOW_MS;
  }
  // A later policy revision may reopen a window before the original expiry.
  // Do not tell a worker to expire a still-live source prematurely.
  if (candidate >= expiry)
    return { status: "blocked", reason: "no_window_before_expiry" };
  if (!Number.isFinite(new Date(candidate).getTime()))
    return { status: "blocked", reason: "configuration_unavailable" };
  if (quietHours) {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone.data,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    // Walk UTC minutes rather than constructing an ambiguous/nonexistent
    // local datetime. This handles both occurrences of a repeated DST hour,
    // skipped hours and non-hour offsets. Bound unusual timezone histories.
    const limit = candidate + 3 * SHOPPER_DELIVERY_WINDOW_MS;
    while (isQuiet(localMinute(formatter, candidate), quietHours)) {
      candidate = Math.floor(candidate / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
      if (candidate >= expiry)
        return { status: "blocked", reason: "no_window_before_expiry" };
      if (candidate > limit || !Number.isFinite(new Date(candidate).getTime()))
        return { status: "blocked", reason: "configuration_unavailable" };
    }
  }
  return candidate === start
    ? { status: "eligible" }
    : { status: "deferred", retryAt: new Date(candidate) };
}
