export const SUPPORTED_LOCALES = ["en", "vi", "ja"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_LABELS: Record<
  Locale,
  { label: string; native: string; flag: string }
> = {
  en: { label: "English", native: "English", flag: "🇺🇸" },
  vi: { label: "Vietnamese", native: "Tiếng Việt", flag: "🇻🇳" },
  ja: { label: "Japanese", native: "日本語", flag: "🇯🇵" },
};

export type TranslationNested = {
  [key: string]: string | TranslationNested;
};

export interface TranslationDictionary {
  common: TranslationNested;
  partner: TranslationNested;
  admin: TranslationNested;
  auth: TranslationNested;
  [key: string]: TranslationNested;
}
