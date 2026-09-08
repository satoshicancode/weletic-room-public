"use client";

import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import { useTranslations } from "@dub/ui";
import { PartnerProgramLinksPageClient } from "./page-client";

export default function PartnerProgramLinksPage() {
  const t = useTranslations("partner");

  return (
    <PageContent title={t("navigation.links") || "Links"}>
      <PageWidthWrapper className="pb-10">
        <PartnerProgramLinksPageClient />
      </PageWidthWrapper>
    </PageContent>
  );
}
