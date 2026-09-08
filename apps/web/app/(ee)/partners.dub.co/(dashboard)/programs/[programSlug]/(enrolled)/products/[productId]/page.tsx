import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import { WeleticProductDetailPageClient } from "./page-client";

export default function WeleticProductDetailPage() {
  return (
    <PageContent title="Product Offer Details">
      <PageWidthWrapper className="pb-10">
        <WeleticProductDetailPageClient />
      </PageWidthWrapper>
    </PageContent>
  );
}
