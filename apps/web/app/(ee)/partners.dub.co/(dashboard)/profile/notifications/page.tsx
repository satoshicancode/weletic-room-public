"use client";

import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import { useTranslations } from "@dub/ui";
import { PartnerSettingsNotificationsPageClient } from "./page-client";

export default function PartnerSettingsNotificationsPage() {
  const t = useTranslations("partner");

  return (
    <PageContent
      title={t("navigation.notifications") || "Notifications"}
      titleInfo={{
        title:
          "Adjust your personal notification preferences and choose which updates you want to receive. These settings will only be applied to your personal account.",
      }}
    >
      <PageWidthWrapper>
        <PartnerSettingsNotificationsPageClient />
      </PageWidthWrapper>
    </PageContent>
  );
}
