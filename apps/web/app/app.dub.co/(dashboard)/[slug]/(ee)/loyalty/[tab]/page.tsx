import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import LoyaltyAdminPageClient from "../../program/loyalty/page-client";

export default async function LoyaltyTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;
  const validTabs: Record<string, string> = {
    overview: "points",
    points: "points",
    earn: "earn",
    earning: "earn",
    redeem: "rewards",
    rewards: "rewards",
    customers: "customers",
    members: "customers",
    accounts: "customers",
    activity: "activity",
    referrals: "referrals",
    referral: "referrals",
    vip: "vip",
    tiers: "vip",
    bonuses: "bonuses",
    campaigns: "bonuses",
    analytics: "analytics",
    onsite: "onsite",
    branding: "onsite",
    widget: "onsite",
    settings: "settings",
    backfill: "settings",
  };

  const activeTab = validTabs[tab?.toLowerCase()] || "points";

  return (
    <PageContent
      title="Customer Loyalty"
      titleInfo={{
        title:
          "Configure shopper points earning, VIP tiers, discount rewards, referrals, launcher widget, and historical opening balances.",
        href: "https://dub.co/help/article/loyalty-program",
      }}
    >
      <PageWidthWrapper className="mb-10">
        <LoyaltyAdminPageClient initialTab={activeTab} />
      </PageWidthWrapper>
    </PageContent>
  );
}
