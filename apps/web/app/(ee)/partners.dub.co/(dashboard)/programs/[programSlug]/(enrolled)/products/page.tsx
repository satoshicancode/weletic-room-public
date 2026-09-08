import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import { WeleticProductsPageClient, WeleticProductsTitle } from "./page-client";

export default function WeleticProductsPage() {
  return (
    <PageContent title={<WeleticProductsTitle />}>
      <PageWidthWrapper className="pb-10">
        <WeleticProductsPageClient />
      </PageWidthWrapper>
    </PageContent>
  );
}
