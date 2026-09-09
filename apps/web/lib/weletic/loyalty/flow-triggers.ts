import {
  resolveShopifyOfflineCredentials,
  shopifyAdminGraphqlRequest,
  ShopifyDiscountError,
} from "@/lib/weletic/loyalty/shopify-discounts";
import { z } from "zod";

export const SHOPIFY_FLOW_TRIGGER_HANDLES = {
  POINTS_EARNED: "weletic-points-earned",
  VIP_TIER_CHANGED: "weletic-vip-tier-changed",
  REWARD_REDEEMED: "weletic-reward-redeemed",
  POINTS_EXPIRING_SOON: "weletic-points-expiring-soon",
  REFERRAL_COMPLETED: "weletic-referral-completed",
} as const;

export type ShopifyFlowTriggerHandle =
  (typeof SHOPIFY_FLOW_TRIGGER_HANDLES)[keyof typeof SHOPIFY_FLOW_TRIGGER_HANDLES];

export const VALID_SHOPIFY_FLOW_TRIGGER_HANDLES = Object.values(
  SHOPIFY_FLOW_TRIGGER_HANDLES,
) as ShopifyFlowTriggerHandle[];

export const SHOPIFY_FLOW_MAX_PAYLOAD_BYTES = 50_000;

export const SHOPIFY_FLOW_TRIGGER_RECEIVE_MUTATION = /* GraphQL */ `
  mutation WeleticLoyaltyFlowTriggerReceive($handle: String!, $payload: JSON!) {
    flowTriggerReceive(handle: $handle, payload: $payload) {
      userErrors {
        field
        message
      }
    }
  }
`;

const IntegerLikeSchema = z.union([
  z.bigint(),
  z.number().int().safe(),
  z.string().regex(/^-?\d+$/, "must be an integer string"),
]);
const PositiveIntegerLikeSchema = z.union([
  z.bigint().positive(),
  z.number().int().positive().safe(),
  z.string().regex(/^[1-9]\d*$/, "must be a positive integer string"),
]);
const NonNegativeIntegerLikeSchema = z.union([
  z.bigint().nonnegative(),
  z.number().int().nonnegative().safe(),
  z.string().regex(/^\d+$/, "must be a non-negative integer string"),
]);
const CustomerGidSchema = z
  .string()
  .trim()
  .regex(
    /^(?:gid:\/\/shopify\/Customer\/|Customer\/)?[1-9]\d*$/,
    "customerGid must contain a numeric Shopify customer ID",
  );
const DecimalLikeSchema = z.union([
  z.number().positive().finite(),
  z.string().regex(/^\d+(?:\.\d+)?$/, "must be a positive decimal string"),
]);

export const PointsEarnedFlowPayloadSchema = z
  .object({
    pointsDelta: IntegerLikeSchema,
    pointsBalance: IntegerLikeSchema,
    customerGid: CustomerGidSchema,
    orderId: z.string().max(255).nullable().optional(),
    reason: z.string().trim().min(1).max(255),
  })
  .strict();

export const ReferralCompletedFlowPayloadSchema = z
  .object({
    customerGid: CustomerGidSchema,
    referralId: z.string().min(1).max(191),
    orderId: z.string().min(1).max(255),
    advocatePoints: NonNegativeIntegerLikeSchema,
    friendPoints: NonNegativeIntegerLikeSchema,
  })
  .strict();

export const VipTierChangedFlowPayloadSchema = z
  .object({
    previousTier: z.string().max(255),
    newTier: z.string().trim().min(1).max(255),
    customerGid: CustomerGidSchema,
    multiplier: DecimalLikeSchema,
  })
  .strict();

export const RewardRedeemedFlowPayloadSchema = z
  .object({
    rewardType: z.string().trim().min(1).max(255),
    discountCode: z.string().trim().min(1).max(255),
    pointsSpent: NonNegativeIntegerLikeSchema,
    customerGid: CustomerGidSchema,
  })
  .strict();

export const PointsExpiringSoonFlowPayloadSchema = z
  .object({
    pointsExpiring: PositiveIntegerLikeSchema,
    expiryDate: z.string().datetime({ offset: true }),
    customerGid: CustomerGidSchema,
    urgency: z.enum(["warning", "last_chance"]),
  })
  .strict();

export type PointsEarnedFlowPayload = z.infer<
  typeof PointsEarnedFlowPayloadSchema
>;
export type VipTierChangedFlowPayload = z.infer<
  typeof VipTierChangedFlowPayloadSchema
>;
export type RewardRedeemedFlowPayload = z.infer<
  typeof RewardRedeemedFlowPayloadSchema
>;
export type PointsExpiringSoonFlowPayload = z.infer<
  typeof PointsExpiringSoonFlowPayloadSchema
>;

const FlowCustomValueSchema = z.string().max(5_000);
const PreparedCustomerReferenceSchema = z.number().int().positive().safe();

export const PreparedReferralCompletedFlowPayloadSchema = z
  .object({
    customer_id: PreparedCustomerReferenceSchema,
    "Referral id": FlowCustomValueSchema,
    "Order id": FlowCustomValueSchema,
    "Advocate points": FlowCustomValueSchema,
    "Friend points": FlowCustomValueSchema,
  })
  .strict();

export const PreparedPointsEarnedFlowPayloadSchema = z
  .object({
    customer_id: PreparedCustomerReferenceSchema,
    "Points delta": FlowCustomValueSchema,
    "Points balance": FlowCustomValueSchema,
    Reason: FlowCustomValueSchema,
    "Order id": FlowCustomValueSchema,
  })
  .strict();
export const PreparedVipTierChangedFlowPayloadSchema = z
  .object({
    customer_id: PreparedCustomerReferenceSchema,
    "Previous tier": FlowCustomValueSchema,
    "New tier": FlowCustomValueSchema,
    Multiplier: FlowCustomValueSchema,
  })
  .strict();
export const PreparedRewardRedeemedFlowPayloadSchema = z
  .object({
    customer_id: PreparedCustomerReferenceSchema,
    "Reward type": FlowCustomValueSchema,
    "Discount code": FlowCustomValueSchema,
    "Points spent": FlowCustomValueSchema,
  })
  .strict();
export const PreparedPointsExpiringSoonFlowPayloadSchema = z
  .object({
    customer_id: PreparedCustomerReferenceSchema,
    "Points expiring": FlowCustomValueSchema,
    "Expiry date": FlowCustomValueSchema,
    Urgency: FlowCustomValueSchema,
  })
  .strict();

export type PreparedShopifyFlowPayload =
  | z.infer<typeof PreparedReferralCompletedFlowPayloadSchema>
  | z.infer<typeof PreparedPointsEarnedFlowPayloadSchema>
  | z.infer<typeof PreparedVipTierChangedFlowPayloadSchema>
  | z.infer<typeof PreparedRewardRedeemedFlowPayloadSchema>
  | z.infer<typeof PreparedPointsExpiringSoonFlowPayloadSchema>;

function integerString(value: bigint | number | string) {
  return typeof value === "bigint" ? value.toString() : String(value);
}

export function shopifyCustomerLegacyId(customerGid: string): number {
  const parsed = CustomerGidSchema.parse(customerGid);
  const numericId = parsed.replace(
    /^(?:gid:\/\/shopify\/Customer\/|Customer\/)/,
    "",
  );
  const result = Number(numericId);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(
      "Shopify customer legacyResourceId must be a positive safe integer.",
    );
  }
  return result;
}

function assertPayloadSize(payload: PreparedShopifyFlowPayload) {
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (payloadBytes >= SHOPIFY_FLOW_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Shopify Flow payload is ${payloadBytes} bytes; it must be under ${SHOPIFY_FLOW_MAX_PAYLOAD_BYTES} bytes.`,
    );
  }
  return payload;
}

export function validatePreparedShopifyFlowPayload(
  handle: ShopifyFlowTriggerHandle,
  payload: unknown,
): PreparedShopifyFlowPayload {
  if (handle === SHOPIFY_FLOW_TRIGGER_HANDLES.REFERRAL_COMPLETED)
    return assertPayloadSize(
      PreparedReferralCompletedFlowPayloadSchema.parse(payload),
    );
  const parsed =
    handle === SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED
      ? PreparedPointsEarnedFlowPayloadSchema.parse(payload)
      : handle === SHOPIFY_FLOW_TRIGGER_HANDLES.VIP_TIER_CHANGED
        ? PreparedVipTierChangedFlowPayloadSchema.parse(payload)
        : handle === SHOPIFY_FLOW_TRIGGER_HANDLES.REWARD_REDEEMED
          ? PreparedRewardRedeemedFlowPayloadSchema.parse(payload)
          : PreparedPointsExpiringSoonFlowPayloadSchema.parse(payload);
  return assertPayloadSize(parsed);
}

/** Maps Weletic's typed event contract to the exact keys declared by Flow. */
export function validateAndNormalizeFlowPayload(
  handle: ShopifyFlowTriggerHandle,
  rawPayload: unknown,
): PreparedShopifyFlowPayload {
  if (handle === SHOPIFY_FLOW_TRIGGER_HANDLES.REFERRAL_COMPLETED) {
    const payload = ReferralCompletedFlowPayloadSchema.parse(rawPayload);
    return assertPayloadSize({
      customer_id: shopifyCustomerLegacyId(payload.customerGid),
      "Referral id": payload.referralId,
      "Order id": payload.orderId,
      "Advocate points": integerString(payload.advocatePoints),
      "Friend points": integerString(payload.friendPoints),
    });
  }
  if (handle === SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED) {
    const payload = PointsEarnedFlowPayloadSchema.parse(rawPayload);
    return assertPayloadSize({
      customer_id: shopifyCustomerLegacyId(payload.customerGid),
      "Points delta": integerString(payload.pointsDelta),
      "Points balance": integerString(payload.pointsBalance),
      Reason: payload.reason,
      "Order id": payload.orderId ?? "",
    });
  }
  if (handle === SHOPIFY_FLOW_TRIGGER_HANDLES.VIP_TIER_CHANGED) {
    const payload = VipTierChangedFlowPayloadSchema.parse(rawPayload);
    return assertPayloadSize({
      customer_id: shopifyCustomerLegacyId(payload.customerGid),
      "Previous tier": payload.previousTier,
      "New tier": payload.newTier,
      Multiplier: String(payload.multiplier),
    });
  }
  if (handle === SHOPIFY_FLOW_TRIGGER_HANDLES.REWARD_REDEEMED) {
    const payload = RewardRedeemedFlowPayloadSchema.parse(rawPayload);
    return assertPayloadSize({
      customer_id: shopifyCustomerLegacyId(payload.customerGid),
      "Reward type": payload.rewardType,
      "Discount code": payload.discountCode,
      "Points spent": integerString(payload.pointsSpent),
    });
  }
  if (handle === SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EXPIRING_SOON) {
    const payload = PointsExpiringSoonFlowPayloadSchema.parse(rawPayload);
    return assertPayloadSize({
      customer_id: shopifyCustomerLegacyId(payload.customerGid),
      "Points expiring": integerString(payload.pointsExpiring),
      "Expiry date": new Date(payload.expiryDate).toISOString(),
      Urgency: payload.urgency,
    });
  }
  throw new Error(`Unrecognized Shopify Flow trigger handle: ${handle}`);
}

export class ShopifyFlowDispatchError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly userErrors: ShopifyFlowUserError[] = [],
  ) {
    super(message);
    this.name = "ShopifyFlowDispatchError";
  }
}

export interface ShopifyFlowUserError {
  field?: string[] | string;
  message: string;
}

export interface DispatchShopifyFlowTriggerParams {
  storeId?: string;
  shopDomain?: string;
  offlineToken?: string;
  handle: ShopifyFlowTriggerHandle;
  payload: unknown;
  customFetch?: typeof fetch;
  maxRetries?: number;
  requestTimeoutMs?: number;
}

export interface ShopifyFlowDispatchResult {
  success: true;
  handle: ShopifyFlowTriggerHandle;
  normalizedPayload: PreparedShopifyFlowPayload;
}

const RetryableGraphqlErrorSchema = z.object({
  extensions: z.object({
    code: z.enum(["INTERNAL_SERVER_ERROR", "THROTTLED"]),
  }),
});

function isRetryableShopifyError(error: ShopifyDiscountError) {
  if (error.code === "THROTTLED" || error.code === "REMOTE_OUTCOME_UNKNOWN") {
    return true;
  }
  // Shopify can return transient server failures in an HTTP 200 GraphQL
  // envelope. The shared transport preserves those raw errors in userErrors
  // under GRAPHQL_USER_ERROR; validation and authorization failures stay final.
  if (error.code === "GRAPHQL_USER_ERROR") {
    return (
      error.userErrors?.some(
        (detail) => RetryableGraphqlErrorSchema.safeParse(detail).success,
      ) ?? false
    );
  }
  if (error.code !== "NETWORK_ERROR") return false;

  // The shared GraphQL transport currently classifies every non-401/403 HTTP
  // failure as NETWORK_ERROR. A deterministic client response must not burn
  // through the durable outbox retry budget; 429 and 5xx remain retryable.
  const httpStatus = error.message.match(/HTTP status (\d{3})/)?.[1];
  return !httpStatus || Number(httpStatus) === 429 || Number(httpStatus) >= 500;
}

/** Keep credential and dispatch failures on the same durable retry contract. */
export function classifyShopifyFlowDispatchError(
  error: unknown,
): ShopifyFlowDispatchError {
  if (error instanceof ShopifyFlowDispatchError) return error;
  if (error instanceof ShopifyDiscountError) {
    return new ShopifyFlowDispatchError(
      error.message,
      isRetryableShopifyError(error),
      error.userErrors ?? [],
    );
  }
  return new ShopifyFlowDispatchError(
    error instanceof Error ? error.message : String(error),
    true,
  );
}

/**
 * Sends one already-durable event to Shopify Flow. Failures are thrown so the
 * database outbox, rather than an in-memory retry loop, owns retry/dead-letter.
 */
export async function dispatchShopifyFlowTrigger(
  params: DispatchShopifyFlowTriggerParams,
): Promise<ShopifyFlowDispatchResult> {
  let normalizedPayload: PreparedShopifyFlowPayload;
  try {
    normalizedPayload = validateAndNormalizeFlowPayload(
      params.handle,
      params.payload,
    );
  } catch (error) {
    throw new ShopifyFlowDispatchError(
      error instanceof Error ? error.message : "Invalid Shopify Flow payload.",
      false,
    );
  }

  try {
    let shopDomain = params.shopDomain;
    let accessToken = params.offlineToken;
    if (!shopDomain || !accessToken) {
      const credentials = await resolveShopifyOfflineCredentials({
        storeId: params.storeId,
        shopDomain,
        customFetch: params.customFetch,
      });
      shopDomain = credentials.shopDomain;
      accessToken = credentials.accessToken;
    }

    const response = await shopifyAdminGraphqlRequest<{
      flowTriggerReceive?: { userErrors?: ShopifyFlowUserError[] };
    }>({
      shopDomain,
      accessToken,
      query: SHOPIFY_FLOW_TRIGGER_RECEIVE_MUTATION,
      variables: { handle: params.handle, payload: normalizedPayload },
      customFetch: params.customFetch,
      maxRetries: params.maxRetries ?? 0,
      requestTimeoutMs: params.requestTimeoutMs,
    });
    const userErrors = response.flowTriggerReceive?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new ShopifyFlowDispatchError(
        userErrors.map(({ message }) => message).join("; "),
        false,
        userErrors,
      );
    }
    if (!response.flowTriggerReceive) {
      throw new ShopifyFlowDispatchError(
        "Shopify Flow returned no flowTriggerReceive result.",
        true,
      );
    }
    return { success: true, handle: params.handle, normalizedPayload };
  } catch (error) {
    throw classifyShopifyFlowDispatchError(error);
  }
}
