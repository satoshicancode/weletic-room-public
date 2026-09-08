import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import LoyaltyAdminPageClient from "./page-client";

export default async function ProgramLoyaltyPage() {
  return (
    <PageContent
      title="Customer Loyalty"
      titleInfo={{
        title:
          "Configure shopper points earning, VIP tiers, discount rewards, referrals, and historical opening balances.",
        href: "https://dub.co/help/article/loyalty-program",
      }}
    >
      <PageWidthWrapper className="mb-10">
        <LoyaltyAdminPageClient />
      </PageWidthWrapper>
    </PageContent>
  );
}
