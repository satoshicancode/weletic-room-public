import en from "@shopify/polaris/locales/en.json";
import ja from "@shopify/polaris/locales/ja.json";
import vi from "@shopify/polaris/locales/vi.json";

// Keep Polaris accessibility messages aligned with the merchant's selected
// language, not just the visible application copy.
export const merchantPolarisTranslations = { en, ja, vi } as const;
