import {
  loyaltyModuleToggleSchema,
  type LoyaltyModuleToggle,
} from "../../../apps/web/lib/weletic/loyalty/module-contract";
import {
  merchantAppearanceUpdateSchema,
  type MerchantAppearanceUpdate,
  type MerchantSettingsUpdate,
} from "../../../apps/web/lib/weletic/merchant-settings/contracts";
import {
  loyaltyModuleResponseSchema,
  merchantAppearanceResponseSchema,
  merchantSettingsResponseSchema,
  reviewModuleResponseSchema,
  shopifyMerchantSettingsInputSchema,
} from "../../../apps/web/lib/weletic/merchant-settings/merchant-contract";
import {
  reviewModuleToggleSchema,
  type ReviewModuleToggle,
} from "../../../apps/web/lib/weletic/reviews/module-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantAppearanceClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  async function request(value?: MerchantAppearanceUpdate) {
    const input =
      value === undefined
        ? undefined
        : merchantAppearanceUpdateSchema.safeParse(value);
    if (input && !input.success) throw new StaffAccessClientError("invalid");
    const result = merchantAppearanceResponseSchema.safeParse(
      await post(
        "/api/merchant/settings",
        input?.success
          ? { operation: "appearance-update", input: input.data }
          : { operation: "appearance-read", input: {} },
      ),
    );
    if (!result.success) throw new StaffAccessClientError("unavailable");
    if (
      input?.success &&
      (result.data.installationGeneration !==
        input.data.expectedInstallationGeneration ||
        result.data.revision !== input.data.expectedRevision + 1 ||
        Object.entries(input.data.settings).some(
          ([key, value]) =>
            result.data.settings[key as keyof typeof result.data.settings] !==
            value,
        ))
    )
      throw new StaffAccessClientError("unavailable");
    return result.data;
  }
  return {
    read: () => request(),
    save: (input: MerchantAppearanceUpdate) => request(input),
  };
}

export function createMerchantSettingsClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  async function request(value: unknown) {
    const input = shopifyMerchantSettingsInputSchema.safeParse(value);
    if (!input.success) throw new StaffAccessClientError("invalid");
    const result = merchantSettingsResponseSchema.safeParse(
      await post("/api/merchant/settings", input.data),
    );
    if (!result.success) throw new StaffAccessClientError("unavailable");
    if (
      input.data.operation === "update" &&
      (result.data.installationGeneration !==
        input.data.input.expectedInstallationGeneration ||
        result.data.revision !== input.data.input.expectedRevision + 1 ||
        Object.entries(input.data.input.settings).some(
          ([key, value]) =>
            result.data.settings[key as keyof typeof result.data.settings] !==
            value,
        ))
    )
      throw new StaffAccessClientError("unavailable");
    return result.data;
  }
  return {
    async loyalty(value: LoyaltyModuleToggle) {
      const input = loyaltyModuleToggleSchema.safeParse(value);
      if (!input.success) throw new StaffAccessClientError("invalid");
      const result = loyaltyModuleResponseSchema.safeParse(
        await post("/api/merchant/settings", {
          operation: "loyalty-module",
          input: input.data,
        }),
      );
      if (
        !result.success ||
        result.data.installationGeneration !==
          input.data.expectedInstallationGeneration ||
        result.data.settings.status !== input.data.status
      )
        throw new StaffAccessClientError("unavailable");
      return result.data;
    },
    read: () => request({ operation: "read", input: {} }),
    save: (input: MerchantSettingsUpdate) =>
      request({ operation: "update", input }),
    async reviews(value: ReviewModuleToggle) {
      const input = reviewModuleToggleSchema.safeParse(value);
      if (!input.success) throw new StaffAccessClientError("invalid");
      const result = reviewModuleResponseSchema.safeParse(
        await post("/api/merchant/settings", {
          operation: "review-module",
          input: input.data,
        }),
      );
      if (
        !result.success ||
        result.data.installationGeneration !==
          input.data.expectedInstallationGeneration ||
        result.data.settings.enabled !== input.data.enabled
      )
        throw new StaffAccessClientError("unavailable");
      return result.data;
    },
  };
}
