import { WELETIC_LOCALES, WeleticLocale } from "@/lib/weletic/localization";

export interface PartnerCatalogPreferences {
  marketId?: string;
  countryCode?: string;
  locale?: WeleticLocale;
}

const PREF_PREFIX = "weletic_partner_catalog_pref_";

export function getPartnerCatalogPreferences(
  programKey?: string,
): PartnerCatalogPreferences | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(
      `${PREF_PREFIX}${programKey || "default"}`,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      marketId:
        typeof parsed.marketId === "string" ? parsed.marketId : undefined,
      countryCode:
        typeof parsed.countryCode === "string" ? parsed.countryCode : undefined,
      locale: WELETIC_LOCALES.includes(parsed.locale)
        ? (parsed.locale as WeleticLocale)
        : undefined,
    };
  } catch {
    return null;
  }
}

export function savePartnerCatalogPreferences(
  programKey: string | undefined,
  prefs: Partial<PartnerCatalogPreferences>,
) {
  if (typeof window === "undefined") return;
  try {
    const key = `${PREF_PREFIX}${programKey || "default"}`;
    const existing = getPartnerCatalogPreferences(programKey) || {};
    const updated = {
      ...existing,
      ...prefs,
    };
    localStorage.setItem(key, JSON.stringify(updated));
  } catch {
    // Ignore localStorage write error (e.g. private browsing quota)
  }
}
