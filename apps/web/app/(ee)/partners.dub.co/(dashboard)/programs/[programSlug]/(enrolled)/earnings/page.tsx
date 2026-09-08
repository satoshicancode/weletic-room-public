"use client";

import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import { useTranslations } from "@dub/ui";
import { EarningsCompositeChart } from "./earnings-composite-chart";
import { EarningsTablePartner } from "./earnings-table";

export default function PartnerProgramEarningsPage() {
  const t = useTranslations("partner");

  return (
    <PageContent title={t("metrics.totalEarnings") || "Earnings"}>
      <PageWidthWrapper className="flex flex-col gap-5 pb-10">
        <EarningsCompositeChart />
        <EarningsTablePartner />
      </PageWidthWrapper>
    </PageContent>
  );
}
