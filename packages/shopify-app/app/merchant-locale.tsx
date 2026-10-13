import type { Dispatch, ReactNode, SetStateAction } from "react";
import { createContext, useContext, useEffect, useState } from "react";

type MerchantLocale = "en" | "ja" | "vi";
type LocaleState = [MerchantLocale, Dispatch<SetStateAction<MerchantLocale>>];
const MerchantLocaleContext = createContext<LocaleState | null>(null);

export function MerchantLocaleProvider({ children }: { children: ReactNode }) {
  const state = useState<MerchantLocale>("en");
  const [, setLocale] = state;
  useEffect(() => {
    const language = navigator.language.slice(0, 2);
    if (language === "ja" || language === "vi") setLocale(language);
  }, [setLocale]);
  return (
    <MerchantLocaleContext.Provider value={state}>
      {children}
    </MerchantLocaleContext.Provider>
  );
}

export function useMerchantLocale(): LocaleState {
  const shared = useContext(MerchantLocaleContext);
  // Standalone page previews retain their own selection outside the app shell.
  const local = useState<MerchantLocale>("en");
  return shared ?? local;
}
