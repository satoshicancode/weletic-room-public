"use client";

import usePartnerProfile from "@/lib/swr/use-partner-profile";
import useProgramEnrollment from "@/lib/swr/use-program-enrollment";
import { getWeleticMessage } from "@/lib/weletic/localization";
import { formatMoney, normalizeCurrency } from "@/lib/weletic/money";
import { LoadingSpinner } from "@dub/ui";
import { fetcher } from "@dub/utils";
import useSWR from "swr";

interface CommerceReport {
  locale: "en" | "vi" | "ja";
  accountingCurrency: string;
  totals: {
    orders: number;
    refunds: number;
    attributedRevenue: string;
    grossOrderTotal: string;
    refundedRevenue: string;
    commissionEarnings: string;
  };
  presentmentCurrencies: Array<{
    currency: string;
    orders: number;
    revenue: string;
  }>;
}

export function WeleticCommerceReportClient() {
  const { partner } = usePartnerProfile();
  const { programEnrollment } = useProgramEnrollment();
  const locale = partner?.preferredLocale ?? "en";
  const { data, error, isLoading } = useSWR<CommerceReport>(
    programEnrollment?.programId
      ? `/api/partner-profile/programs/${programEnrollment.programId}/commerce-report?locale=${locale}`
      : undefined,
    fetcher,
  );

  if (isLoading || !data) {
    return (
      <div className="flex min-h-52 items-center justify-center">
        {error ? (
          <p className="text-sm text-neutral-500">
            {getWeleticMessage(locale, "reporting.loadError")}
          </p>
        ) : (
          <LoadingSpinner />
        )}
      </div>
    );
  }
  const currency = normalizeCurrency(data.accountingCurrency);
  const money = (amount: string) =>
    formatMoney({ amount: BigInt(amount), currency }, data.locale);
  const cards = [
    {
      label: getWeleticMessage(data.locale, "reporting.revenue"),
      value: money(data.totals.attributedRevenue),
    },
    {
      label: getWeleticMessage(data.locale, "reporting.earnings"),
      value: money(data.totals.commissionEarnings),
    },
    {
      label: getWeleticMessage(data.locale, "reporting.orders"),
      value: data.totals.orders.toLocaleString(data.locale),
    },
    {
      label: getWeleticMessage(data.locale, "reporting.refunds"),
      value: data.totals.refunds.toLocaleString(data.locale),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="rounded-xl border border-neutral-200 bg-white p-4"
          >
            <p className="text-sm text-neutral-500">{card.label}</p>
            <p className="mt-2 text-2xl font-semibold text-neutral-900">
              {card.value}
            </p>
          </div>
        ))}
      </div>
      <section className="rounded-xl border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-4 py-3">
          <h2 className="font-medium text-neutral-900">
            {getWeleticMessage(data.locale, "reporting.customerCurrencies")}
          </h2>
        </div>
        <div className="divide-y divide-neutral-100">
          {data.presentmentCurrencies.map((row) => (
            <div
              key={row.currency}
              className="flex items-center justify-between px-4 py-3 text-sm"
            >
              <span className="font-medium text-neutral-700">
                {row.currency}
              </span>
              <span className="text-neutral-500">
                {row.orders.toLocaleString(data.locale)}{" "}
                {getWeleticMessage(data.locale, "reporting.orderSuffix")}
              </span>
              <span className="font-medium text-neutral-900">
                {formatMoney(
                  {
                    amount: BigInt(row.revenue),
                    currency: normalizeCurrency(row.currency),
                  },
                  data.locale,
                )}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function WeleticCommerceReportTitle() {
  const { partner } = usePartnerProfile();
  return getWeleticMessage(partner?.preferredLocale, "reporting.title");
}
