import {
  loyaltyConfigurationResponseSchema,
  shopifyLoyaltyConfigurationInputSchema,
  type LoyaltyConfigurationUpdate,
} from "../../../apps/web/lib/weletic/loyalty/configuration-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

// Only used after the strict Decimal(10,4) string contract succeeds.
function canonicalRate(value: string) {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function createMerchantLoyaltyConfigurationClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  async function request(value: unknown) {
    const input = shopifyLoyaltyConfigurationInputSchema.safeParse(value);
    if (!input.success) throw new StaffAccessClientError("invalid");
    const result = loyaltyConfigurationResponseSchema.safeParse(
      await post("/api/merchant/loyalty-configuration", input.data),
    );
    if (!result.success) throw new StaffAccessClientError("unavailable");
    if (input.data.operation === "update") {
      const { expectedInstallationGeneration, settings } = input.data.input;
      const saved = result.data.program?.settings;
      if (
        !saved ||
        result.data.installationGeneration !== expectedInstallationGeneration ||
        Object.entries(settings).some(([key, value]) => {
          if (value === undefined) return false;
          if (key === "pointsPerCurrencyUnit" && typeof value === "string")
            return (
              canonicalRate(saved.pointsPerCurrencyUnit) !==
              canonicalRate(value)
            );
          return saved[key as keyof typeof saved] !== value;
        })
      )
        throw new StaffAccessClientError("unavailable");
      // The token identifies configuration state, not a write counter. A
      // successful identical-state save may return the same token. Never retry.
    }
    return result.data;
  }
  return {
    read: () => request({ operation: "read" }),
    save: (input: LoyaltyConfigurationUpdate) =>
      request({ operation: "update", input }),
  };
}
