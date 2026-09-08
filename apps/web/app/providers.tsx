"use client";

import {
  I18nProvider,
  KeyboardShortcutProvider,
  TooltipProvider,
} from "@dub/ui";
import PlausibleProvider from "next-plausible";
import { ReactNode } from "react";
import { Toaster } from "sonner";
import { SWRConfig } from "swr";

export default function RootProviders({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <TooltipProvider>
        <PlausibleProvider
          enabled={process.env.NEXT_PUBLIC_WELETIC_ISOLATED_DEVELOPMENT !== "1"}
        >
          <KeyboardShortcutProvider>
            <SWRConfig
              value={{
                dedupingInterval: 60_000,
                keepPreviousData: true,
                revalidateOnFocus: false,
                revalidateOnReconnect: true,
              }}
            >
              <Toaster
                className="pointer-events-auto"
                position="bottom-center"
              />
              {children}
            </SWRConfig>
          </KeyboardShortcutProvider>
        </PlausibleProvider>
      </TooltipProvider>
    </I18nProvider>
  );
}
