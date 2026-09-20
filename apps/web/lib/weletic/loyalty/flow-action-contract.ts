import { createHash } from "node:crypto";
import { z } from "zod";

export const FLOW_POINTS_ACTION_HANDLE = "weletic-adjust-points";
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,190}$/);
const numericId = z.union([
  z.string().regex(/^[1-9]\d{0,19}$/),
  z.number().int().positive().safe().transform(String),
]);
const shopId = z.union([
  numericId,
  z
    .string()
    .regex(/^gid:\/\/shopify\/Shop\/[1-9]\d{0,19}$/)
    .transform((value) => value.slice("gid://shopify/Shop/".length)),
]);
const customerId = z
  .string()
  .regex(/^gid:\/\/shopify\/Customer\/[1-9]\d{0,19}$/);
const points = z
  .string()
  .max(20)
  .refine((value) => {
    if (!/^-?[1-9]\d{0,18}$/.test(value)) return false;
    const amount = BigInt(value);
    return (
      amount >= BigInt("-9223372036854775808") &&
      amount <= BigInt("9223372036854775807")
    );
  }, "An exact non-zero signed 64-bit integer string is required");

/** Parse only after HMAC verification. This schema confers no write authority:
 * the executor must prove store ownership and current persisted grant authority.
 */
export const FlowPointsActionSchema = z
  .object({
    handle: z.literal(FLOW_POINTS_ACTION_HANDLE),
    shop_id: shopId,
    shopify_domain: z
      .string()
      .max(255)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/),
    action_run_id: identifier,
    action_definition_id: z.string().min(1).max(191).optional(),
    step_reference: identifier.optional(),
    properties: z
      .object({
        customer_id: customerId,
        grant_id: z.string().regex(/^wflowgrant_[A-Za-z0-9_-]{20}$/),
        points_delta: points,
      })
      .strict(),
  })
  .strict();

export type FlowPointsAction = z.infer<typeof FlowPointsActionSchema>;

/** Stable across domain aliases and installation replacement. Persistence must
 * uniquely scope this key to the resolved store; do not include a mutable grant.
 */
export function flowPointsActionRunKey(input: FlowPointsAction) {
  const action = FlowPointsActionSchema.parse(input);
  return createHash("sha256")
    .update(
      JSON.stringify([action.handle, action.shop_id, action.action_run_id]),
    )
    .digest("hex");
}

export function flowPointsActionDigest(input: FlowPointsAction) {
  const action = FlowPointsActionSchema.parse(input);
  return createHash("sha256")
    .update(
      JSON.stringify([
        action.handle,
        action.shop_id,
        action.action_run_id,
        action.properties.customer_id,
        action.properties.grant_id,
        action.properties.points_delta,
      ]),
    )
    .digest("hex");
}
