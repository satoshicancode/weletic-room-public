import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import { ShoppersAdmin } from "@/ui/weletic/shoppers/shoppers-admin";

export default function ShoppersPage() {
  return (
    <PageContent title="Customers">
      <PageWidthWrapper className="mb-10">
        <ShoppersAdmin />
      </PageWidthWrapper>
    </PageContent>
  );
}
