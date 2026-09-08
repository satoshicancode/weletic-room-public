"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { en } from "./locales/en";
import { ja } from "./locales/ja";
import { vi } from "./locales/vi";
import {
  DEFAULT_LOCALE,
  Locale,
  SUPPORTED_LOCALES,
  TranslationDictionary,
} from "./types";

const DICTIONARIES: Record<Locale, TranslationDictionary> = {
  en,
  vi,
  ja,
};

export const LOCALE_COOKIE_NAME = "NEXT_LOCALE";

export function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[2]) : null;
}

export function setCookie(name: string, value: string, days = 365) {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  dictionary: TranslationDictionary;
  t: (path: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  dictionary: en,
  t: (path: string) => path,
});

function getNestedValue(obj: any, path: string): string | undefined {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return typeof current === "string" ? current : undefined;
}

export function I18nProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (initialLocale && SUPPORTED_LOCALES.includes(initialLocale)) {
      return initialLocale;
    }
    const cookieLocale = getCookie(LOCALE_COOKIE_NAME) as Locale | null;
    if (cookieLocale && SUPPORTED_LOCALES.includes(cookieLocale)) {
      return cookieLocale;
    }
    return DEFAULT_LOCALE;
  });

  const setLocale = useCallback((newLocale: Locale) => {
    if (SUPPORTED_LOCALES.includes(newLocale)) {
      setLocaleState(newLocale);
      setCookie(LOCALE_COOKIE_NAME, newLocale);
      if (typeof document !== "undefined") {
        document.documentElement.lang = newLocale;
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("localechange", { detail: newLocale }),
        );
      }
    }
  }, []);

  useEffect(() => {
    const handleLocaleChange = (e: Event) => {
      const customEvent = e as CustomEvent<Locale>;
      if (
        customEvent.detail &&
        SUPPORTED_LOCALES.includes(customEvent.detail) &&
        customEvent.detail !== locale
      ) {
        setLocaleState(customEvent.detail);
        if (typeof document !== "undefined") {
          document.documentElement.lang = customEvent.detail;
        }
      }
    };
    window.addEventListener("localechange", handleLocaleChange);
    return () => {
      window.removeEventListener("localechange", handleLocaleChange);
    };
  }, [locale]);

  const dictionary = useMemo(() => DICTIONARIES[locale] || en, [locale]);

  const t = useCallback(
    (path: string, params?: Record<string, string | number>): string => {
      const val = getNestedValue(dictionary, path);
      let result =
        typeof val === "string"
          ? val
          : typeof getNestedValue(en, path) === "string"
            ? (getNestedValue(en, path) as string)
            : path;

      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          result = result.replace(new RegExp(`{{${k}}}`, "g"), String(v));
        });
      }
      return result;
    },
    [dictionary],
  );

  const value = useMemo(
    () => ({ locale, setLocale, dictionary, t }),
    [locale, setLocale, dictionary, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function useTranslations<Namespace extends keyof TranslationDictionary>(
  namespace?: Namespace,
) {
  const { t, locale } = useI18n();

  return useCallback(
    (key: string, params?: Record<string, string | number>) => {
      const fullPath = namespace ? `${namespace}.${key}` : key;
      return t(fullPath, params);
    },
    [t, namespace],
  );
}
