"use client";

import { cn } from "@dub/utils";
import { Check, Globe } from "lucide-react";
import { useState } from "react";
import { LOCALE_LABELS, SUPPORTED_LOCALES, useI18n } from "./i18n";
import { Popover } from "./popover";

export function LanguageSelector({
  className,
  variant = "button",
  align = "end",
  onSelect,
}: {
  className?: string;
  variant?: "button" | "menu-item";
  align?: "start" | "center" | "end";
  onSelect?: () => void;
}) {
  const { locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);

  const currentConfig = LOCALE_LABELS[locale] || LOCALE_LABELS.en;

  return (
    <Popover
      openPopover={open}
      setOpenPopover={setOpen}
      align={align}
      content={
        <div className="w-48 p-1">
          <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Language / Ngôn ngữ
          </div>
          {SUPPORTED_LOCALES.map((loc) => {
            const item = LOCALE_LABELS[loc];
            const isSelected = locale === loc;
            return (
              <button
                key={loc}
                type="button"
                onClick={() => {
                  setLocale(loc);
                  setOpen(false);
                  onSelect?.();
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                  isSelected
                    ? "bg-neutral-100 font-medium text-neutral-900"
                    : "text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900",
                )}
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-base leading-none">{item.flag}</span>
                  <div className="flex flex-col">
                    <span className="text-sm leading-tight">{item.native}</span>
                    <span className="text-xs leading-tight text-neutral-400">
                      {item.label}
                    </span>
                  </div>
                </div>
                {isSelected && <Check className="size-4 shrink-0 text-black" />}
              </button>
            );
          })}
        </div>
      }
    >
      {variant === "menu-item" ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={cn(
            "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-base text-neutral-600 transition-all duration-75 hover:bg-neutral-200/50 active:bg-neutral-200/80 sm:text-sm",
            className,
          )}
        >
          <div className="flex items-center gap-x-4">
            <Globe className="size-4 shrink-0 text-neutral-500" />
            <span>Language</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-500">
            <span>{currentConfig.flag}</span>
            <span>{currentConfig.native}</span>
          </div>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition-colors hover:bg-neutral-50 active:bg-neutral-100",
            className,
          )}
        >
          <Globe className="size-3.5 text-neutral-500" />
          <span>{currentConfig.flag}</span>
          <span>{currentConfig.native}</span>
        </button>
      )}
    </Popover>
  );
}
