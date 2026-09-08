import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import { MerchantSettingsAdmin } from "@/ui/weletic/merchant-settings/settings-admin";
export default function MerchantSettingsPage() {
  return (
    <PageContent title="Loyalty & reviews settings">
      <PageWidthWrapper className="mb-10">
        <MerchantSettingsAdmin />
      </PageWidthWrapper>
    </PageContent>
  );
}
