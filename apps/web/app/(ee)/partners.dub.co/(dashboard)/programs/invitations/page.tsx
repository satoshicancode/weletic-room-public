"use client";

import { PageContent } from "@/ui/layout/page-content";
import { useTranslations } from "@dub/ui";
import { ProgramInvitationsPageClient } from "./page-client";

export default function ProgramInvitationsPage() {
  const t = useTranslations("partner");

  return (
    <PageContent title={t("navigation.invitations") || "Invitations"}>
      <ProgramInvitationsPageClient />
    </PageContent>
  );
}
