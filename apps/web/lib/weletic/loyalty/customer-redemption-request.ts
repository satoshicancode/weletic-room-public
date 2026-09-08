import { z } from "zod";

/**
 * Internal clients historically sent JSON numbers, while current clients send
 * digit strings so selections larger than JavaScript's safe-integer range stay
 * exact. Normalize both supported wire forms before financial validation.
 */
export const customerRedemptionPointsRequestedSchema = z
  .union([
    z
      .string()
      .regex(
        /^[1-9]\d*$/,
        "pointsRequested must be a positive whole-number string.",
      ),
    z.number().int().safe().positive(),
  ])
  .transform((value) => String(value));
