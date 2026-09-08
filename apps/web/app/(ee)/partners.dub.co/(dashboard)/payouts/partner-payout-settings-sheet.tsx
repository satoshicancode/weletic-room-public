"use client";

import { updatePartnerPayoutSettingsAction } from "@/lib/actions/partners/update-partner-payout-settings";
import { getEffectivePayoutMode } from "@/lib/api/payouts/get-effective-payout-mode";
import { mutatePrefix } from "@/lib/swr/mutate";
import usePartnerPayoutSettings from "@/lib/swr/use-partner-payout-settings";
import usePartnerProfile from "@/lib/swr/use-partner-profile";
import useProgramEnrollments from "@/lib/swr/use-program-enrollments";
import { getWeleticMessage } from "@/lib/weletic/localization";
import { WELETIC_PAYOUT_PROVIDERS } from "@/lib/weletic/payouts/providers";
import { partnerPayoutSettingsSchema } from "@/lib/zod/schemas/partners";
import { CountryCombobox } from "@/ui/partners/country-combobox";
import { PayoutMethodSelector } from "@/ui/partners/payouts/payout-method-cards";
import { PAYOUT_METHODS } from "@/ui/partners/payouts/payout-method-config";
import { PayoutMethodDropdown } from "@/ui/partners/payouts/payout-method-dropdown";
import {
  BlurImage,
  Button,
  InfoTooltip,
  Sheet,
  useRouterStuff,
  useScrollProgress,
  useTranslations,
} from "@dub/ui";
import { fetcher, OG_AVATAR_URL } from "@dub/utils";
import { useAction } from "next-safe-action/hooks";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm, type UseFormRegister } from "react-hook-form";
import TextareaAutosize from "react-textarea-autosize";
import { toast } from "sonner";
import useSWR from "swr";
import * as z from "zod/v4";

type PartnerPayoutSettingsFormData = z.infer<
  typeof partnerPayoutSettingsSchema
>;

function useExternalPayoutEnrollments() {
  const { partner } = usePartnerProfile();
  const { programEnrollments } = useProgramEnrollments();

  const externalPayoutEnrollments = useMemo(() => {
    if (!programEnrollments || !partner) return [];

    return programEnrollments.filter((enrollment) => {
      const payoutMode = getEffectivePayoutMode({
        payoutMode: enrollment.program.payoutMode,
        payoutsEnabledAt: partner.payoutsEnabledAt,
      });

      return payoutMode === "external";
    });
  }, [programEnrollments, partner]);

  return {
    externalPayoutEnrollments,
  };
}

export function PartnerPayoutSettingsSheet() {
  const { queryParams, searchParams } = useRouterStuff();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const settings = searchParams.get("settings");

    if (settings === "true") {
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  }, [searchParams]);

  return (
    <Sheet
      open={isOpen}
      onOpenChange={setIsOpen}
      onClose={() => {
        queryParams({
          del: "settings",
        });
      }}
    >
      <PartnerPayoutSettingsSheetInner />
    </Sheet>
  );
}

function PartnerPayoutSettingsSheetInner() {
  const t = useTranslations("partner");
  const tCommon = useTranslations("common");
  const { partner } = usePartnerProfile();
  const { queryParams } = useRouterStuff();

  const {
    register,
    handleSubmit,
    formState: { isDirty },
  } = useForm<PartnerPayoutSettingsFormData>({
    defaultValues: {
      companyName: partner?.companyName || undefined,
      address: partner?.invoiceSettings?.address || undefined,
      taxId: partner?.invoiceSettings?.taxId || undefined,
    },
  });

  const { executeAsync, isPending } = useAction(
    updatePartnerPayoutSettingsAction,
    {
      onSuccess: async () => {
        toast.success(
          tCommon("actions.saved") || "Payout settings updated successfully!",
        );
        queryParams({ del: "settings" });
        mutatePrefix("/api/partner-profile");
      },
      onError({ error }) {
        toast.error(error.serverError);
      },
    },
  );

  const onSubmit = async (data: PartnerPayoutSettingsFormData) => {
    await executeAsync(data);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const { scrollProgress, updateScrollProgress } = useScrollProgress(scrollRef);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex h-full flex-col">
      <div className="flex h-16 items-center justify-between border-b border-neutral-200 px-6 py-4">
        <Sheet.Title className="flex items-center gap-1 text-lg font-semibold">
          {t("payouts.setPayoutMethod") || "Payout settings"}{" "}
          <InfoTooltip
            content={
              t("payouts.payoutSettingsTooltip") ||
              "Learn how to set up your payout account and receive payouts."
            }
          />
        </Sheet.Title>
      </div>

      <div className="relative flex-1 overflow-y-auto">
        <div
          ref={scrollRef}
          onScroll={updateScrollProgress}
          className="scrollbar-hide h-full space-y-10 overflow-y-auto bg-neutral-50 p-4 sm:p-6"
        >
          <div className="space-y-8 divide-y divide-neutral-200">
            <PayoutMethodsSection />
            <SettlementPreferencesSection />
            <ConnectedExternalAccounts />
            <InvoiceDetailsSection register={register} />
          </div>
        </div>
        <div
          className="pointer-events-none absolute -bottom-px left-0 h-16 w-full rounded-b-lg bg-gradient-to-t from-white sm:bottom-0"
          style={{ opacity: 1 - Math.pow(scrollProgress, 2) }}
        />
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-neutral-200 p-5">
        <Button
          variant="secondary"
          text={tCommon("actions.cancel") || "Cancel"}
          disabled={isPending}
          className="h-8 w-fit px-3"
          onClick={() => {
            queryParams({
              del: "settings",
            });
          }}
        />

        <Button
          text={tCommon("actions.save") || "Save"}
          className="h-8 w-fit px-3"
          loading={isPending}
          disabled={!isDirty}
          type="submit"
        />
      </div>
    </form>
  );
}

type SettlementProfile = {
  id: string;
  programId: string;
  country: string;
  payoutCurrency: string;
  provider: "stripe_connect" | "paypal" | "bank_transfer" | "manual";
  method: "bank" | "wallet" | "paypal" | "manual";
  status: "draft" | "pending_verification" | "verified" | "disabled";
  locale: "en" | "vi" | "ja";
  details?: { accountLabel?: string; accountLast4?: string } | null;
};

const SETTLEMENT_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "VND",
  "AUD",
  "CAD",
  "SGD",
];

const payoutMethodForProvider = (provider: SettlementProfile["provider"]) =>
  provider === "paypal" ? "paypal" : provider === "manual" ? "manual" : "bank";

function SettlementPreferencesSection() {
  const { partner } = usePartnerProfile();
  const { programEnrollments } = useProgramEnrollments();
  const { data: profiles, mutate } = useSWR<SettlementProfile[]>(
    "/api/partner-profile/payout-profile",
    fetcher,
  );
  const [draft, setDraft] = useState<SettlementProfile | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (draft || !profiles || !partner || !programEnrollments?.length) return;
    const profile =
      profiles.find(({ status }) => status === "verified") ?? profiles[0];
    const programId = profile?.programId ?? programEnrollments[0].programId;
    setDraft(
      profile ?? {
        id: "",
        programId,
        country: partner.country ?? "US",
        payoutCurrency: partner.preferredPayoutCurrency ?? "USD",
        provider: "manual",
        method: "manual",
        status: "draft",
        locale: partner.preferredLocale ?? "en",
        details: {},
      },
    );
  }, [draft, partner, profiles, programEnrollments]);

  if (!draft) return null;

  const updateDraft = (update: Partial<SettlementProfile>) =>
    setDraft((current) => (current ? { ...current, ...update } : current));
  const message = (key: Parameters<typeof getWeleticMessage>[1]) =>
    getWeleticMessage(draft.locale, key);
  const statusMessage = {
    draft: message("settlement.status.draft"),
    pending_verification: message("settlement.status.pending"),
    verified: message("settlement.status.verified"),
    disabled: message("settlement.status.disabled"),
  }[draft.status];
  const providerCurrencies =
    WELETIC_PAYOUT_PROVIDERS[draft.provider].supportedPayoutCurrencies;
  const settlementCurrencies = providerCurrencies
    ? SETTLEMENT_CURRENCIES.filter((currency) =>
        (providerCurrencies as readonly string[]).includes(currency),
      )
    : SETTLEMENT_CURRENCIES;

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/partner-profile/payout-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country: draft.country,
          programId: draft.programId,
          payoutCurrency: draft.payoutCurrency,
          provider: draft.provider,
          method: draft.method,
          locale: draft.locale,
          details: draft.details,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error?.message ?? result.message);
      }
      setDraft(result);
      await mutate();
      mutatePrefix("/api/partner-profile");
      toast.success(message("settlement.submitted"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : message("settlement.saveError"),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 py-6">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-base font-semibold leading-6 text-neutral-900">
            {message("settlement.title")}
          </h4>
          <span className="rounded-full bg-neutral-100 px-2 py-1 text-xs font-medium capitalize text-neutral-600">
            {statusMessage}
          </span>
        </div>
        <p className="text-sm font-medium text-neutral-500">
          {message("settlement.description")}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-neutral-900">
          {message("settlement.program")}
          <select
            value={draft.programId}
            onChange={(event) => {
              const programId = event.target.value;
              const existing = profiles?.find(
                (profile) => profile.programId === programId,
              );
              setDraft(
                existing ?? {
                  ...draft,
                  id: "",
                  programId,
                  status: "draft",
                },
              );
            }}
            className="mt-1.5 block h-10 w-full rounded-md border-neutral-300 bg-white text-sm"
          >
            {programEnrollments?.map((enrollment) => (
              <option key={enrollment.programId} value={enrollment.programId}>
                {enrollment.program.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-neutral-900">
          {message("settlement.country")}
          <CountryCombobox
            value={draft.country}
            onChange={(country) => updateDraft({ country })}
          />
        </label>
        <label className="text-sm font-medium text-neutral-900">
          {message("settlement.currency")}
          <select
            value={draft.payoutCurrency}
            onChange={(event) =>
              updateDraft({ payoutCurrency: event.target.value })
            }
            className="mt-1.5 block h-10 w-full rounded-md border-neutral-300 bg-white text-sm"
          >
            {settlementCurrencies.map((currency) => (
              <option key={currency}>{currency}</option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-neutral-900">
          {message("settlement.provider")}
          <select
            value={draft.provider}
            onChange={(event) => {
              const provider = event.target
                .value as SettlementProfile["provider"];
              const supportedCurrencies =
                WELETIC_PAYOUT_PROVIDERS[provider].supportedPayoutCurrencies;
              updateDraft({
                provider,
                method: payoutMethodForProvider(provider),
                ...(supportedCurrencies &&
                  !(supportedCurrencies as readonly string[]).includes(
                    draft.payoutCurrency,
                  ) && {
                    payoutCurrency: supportedCurrencies[0],
                  }),
              });
            }}
            className="mt-1.5 block h-10 w-full rounded-md border-neutral-300 bg-white text-sm"
          >
            <option value="stripe_connect">Stripe Connect</option>
            <option value="paypal">PayPal</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        <label className="text-sm font-medium text-neutral-900">
          {message("settlement.accountLabel")}
          <input
            value={draft.details?.accountLabel ?? ""}
            onChange={(event) =>
              updateDraft({
                details: {
                  ...draft.details,
                  accountLabel: event.target.value || undefined,
                },
              })
            }
            placeholder={message("settlement.accountPlaceholder")}
            className="mt-1.5 block h-10 w-full rounded-md border-neutral-300 text-sm"
          />
        </label>
        {draft.provider === "bank_transfer" && (
          <label className="text-sm font-medium text-neutral-900">
            {message("settlement.accountLast4")}
            <input
              value={draft.details?.accountLast4 ?? ""}
              onChange={(event) =>
                updateDraft({
                  details: {
                    ...draft.details,
                    accountLast4: event.target.value || undefined,
                  },
                })
              }
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              required
              className="mt-1.5 block h-10 w-full rounded-md border-neutral-300 text-sm"
            />
          </label>
        )}
      </div>

      <Button
        type="button"
        variant="secondary"
        text={message("settlement.save")}
        className="h-8 w-fit px-3"
        loading={saving}
        onClick={save}
      />
    </div>
  );
}

function PayoutMethodsSectionSkeleton() {
  return (
    <div
      className="flex w-full cursor-default items-center justify-between rounded-lg border border-neutral-200 bg-white p-2"
      aria-hidden
    >
      <div className="flex min-w-0 items-center gap-x-2.5 pr-2">
        <div className="size-8 shrink-0 animate-pulse rounded-lg bg-neutral-200" />
        <div className="min-w-0">
          <div className="h-3 w-24 animate-pulse rounded bg-neutral-200" />
          <div className="mt-1 h-3 w-44 animate-pulse rounded bg-neutral-200" />
        </div>
      </div>
      <div className="size-4 shrink-0 animate-pulse rounded bg-neutral-200" />
    </div>
  );
}

function PayoutMethodsSection() {
  const t = useTranslations("partner");
  const { availablePayoutMethods } = usePartnerProfile();
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);

  const {
    payoutMethods: payoutMethodsData,
    isLoading: isPayoutMethodsLoading,
  } = usePartnerPayoutSettings();

  const hasConnectedAccount =
    payoutMethodsData?.some((m) => m.connected) ?? false;

  const filteredMethods = PAYOUT_METHODS.filter((m) =>
    availablePayoutMethods.includes(m.id),
  );

  const currentMethod = selectedMethodId
    ? filteredMethods.find((m) => m.id === selectedMethodId) ||
      filteredMethods[0]
    : filteredMethods[0];

  const otherMethods = filteredMethods.filter(
    (m) => m.id !== currentMethod?.id,
  );

  if (availablePayoutMethods.length === 0) {
    return null;
  }

  // Show stablecoin as a recommended option when available but not yet connected, to encourage partners to add it
  // TODO: Add this back when stablecoin is supported in Connect
  // const showStablecoinRecommended =
  //   availablePayoutMethods.includes("stablecoin") &&
  //   !payoutMethodsData?.some((m) => m.type === "stablecoin" && m.connected);
  const showStablecoinRecommended = false;

  return (
    <div>
      <h4 className="text-content-emphasis mb-3 text-base font-semibold leading-6">
        {t("payouts.payoutMethod") || "Payout account"}
      </h4>
      {isPayoutMethodsLoading ? (
        <PayoutMethodsSectionSkeleton />
      ) : hasConnectedAccount ? (
        <div className="space-y-3">
          <PayoutMethodDropdown />
          {showStablecoinRecommended &&
            payoutMethodsData?.some((m) => m.type === "stablecoin") && (
              <PayoutMethodSelector
                payoutMethods={payoutMethodsData!.filter(
                  (m) => m.type === "stablecoin",
                )}
                variant="compact"
              />
            )}
        </div>
      ) : (
        <PayoutMethodSelector
          payoutMethods={
            currentMethod && payoutMethodsData
              ? payoutMethodsData.filter((m) => m.type === currentMethod.id)
              : []
          }
          variant="compact"
          actionFooter={(_setting) =>
            otherMethods.length > 0 ? (
              <div className="mt-1 flex justify-center">
                {otherMethods.map((method) => (
                  <button
                    key={method.id}
                    type="button"
                    onClick={() => setSelectedMethodId(method.id)}
                    className="text-xs font-medium text-neutral-400 transition-colors hover:text-neutral-600"
                  >
                    {t("payouts.connectMethod") || "Connect"} {method.title}
                    {method.recommended
                      ? ` (${t("payouts.recommended") || "recommended"})`
                      : ""}
                  </button>
                ))}
              </div>
            ) : null
          }
        />
      )}
    </div>
  );
}

function InvoiceDetailsSection({
  register,
}: {
  register: UseFormRegister<PartnerPayoutSettingsFormData>;
}) {
  const t = useTranslations("partner");

  return (
    <div className="space-y-4 py-6">
      <div>
        <h4 className="text-base font-semibold leading-6 text-neutral-900">
          {t("payouts.invoiceDetailsTitle") || "Invoice details (optional)"}
        </h4>
        <p className="text-sm font-medium text-neutral-500">
          {t("payouts.invoiceDetailsDesc") ||
            "This information is added to your payout invoices."}
        </p>
      </div>

      <div>
        <label
          htmlFor="companyName"
          className="text-sm font-medium text-neutral-900"
        >
          {t("payouts.businessName") || "Business name"}
        </label>
        <div className="relative mt-1.5 rounded-md shadow-sm">
          <input
            id="companyName"
            className="block w-full rounded-md border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-neutral-500 sm:text-sm"
            {...register("companyName")}
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="address"
          className="text-sm font-medium text-neutral-900"
        >
          {t("payouts.businessAddress") || "Business address"}
        </label>
        <TextareaAutosize
          id="address"
          className="mt-1.5 block w-full rounded-md border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-neutral-500 sm:text-sm"
          minRows={3}
          {...register("address")}
        />
      </div>

      <div>
        <label htmlFor="taxId" className="text-sm font-medium text-neutral-900">
          {t("payouts.businessTaxId") || "Business tax ID"}
        </label>
        <div className="relative mt-1.5 rounded-md shadow-sm">
          <input
            id="taxId"
            className="block w-full rounded-md border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-neutral-500 sm:text-sm"
            {...register("taxId")}
          />
        </div>
      </div>
    </div>
  );
}

function ConnectedExternalAccounts() {
  const t = useTranslations("partner");
  const { externalPayoutEnrollments } = useExternalPayoutEnrollments();

  if (!externalPayoutEnrollments || externalPayoutEnrollments.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3 py-6">
      <div>
        <h4 className="text-content-emphasis text-base font-semibold leading-6">
          {t("payouts.connectedExternalAccounts") ||
            "Connected external accounts"}
        </h4>
      </div>

      <div className="space-y-2">
        {externalPayoutEnrollments.map((enrollment) => (
          <div
            key={enrollment.programId}
            className="flex h-12 items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-white px-3 py-2"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <BlurImage
                width={24}
                height={24}
                src={
                  enrollment.program.logo ||
                  `${OG_AVATAR_URL}${enrollment.program.name}`
                }
                alt={enrollment.program.name}
                className="size-6 shrink-0 rounded-full"
              />
              <span className="text-content-emphasis truncate text-sm font-semibold">
                {enrollment.program.name}
              </span>
            </div>
            <Link
              href={`/programs/${enrollment.program.slug}`}
              className="shrink-0"
              target="_blank"
            >
              <Button
                type="button"
                variant="secondary"
                text={t("payouts.viewProgram") || "View program"}
                className="border-border-subtle h-6 rounded-md px-2 py-3.5 text-sm"
              />
            </Link>
          </div>
        ))}
      </div>

      <p className="text-content-subtle text-xs font-normal leading-4">
        {t("payouts.externalAccountsNotice") ||
          "These programs manage payouts externally through their own systems."}
        <Link
          href="https://dub.co/help/article/receiving-payouts"
          target="_blank"
          className="ml-1 underline underline-offset-2"
        >
          {t("common.actions.viewMore") || "Learn more"}
        </Link>
      </p>
    </div>
  );
}

export function usePartnerPayoutSettingsSheet() {
  const { queryParams } = useRouterStuff();

  const openSettings = useCallback(() => {
    queryParams({
      set: {
        settings: "true",
      },
    });
  }, [queryParams]);

  const PartnerPayoutSettingsSheetCallback = useCallback(() => {
    return <PartnerPayoutSettingsSheet />;
  }, []);

  return useMemo(
    () => ({
      openSettings,
      PartnerPayoutSettingsSheet: PartnerPayoutSettingsSheetCallback,
    }),
    [openSettings, PartnerPayoutSettingsSheetCallback],
  );
}
