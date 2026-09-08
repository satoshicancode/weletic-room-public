import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import { CommerceRulesClient } from "./rules-client";

export default function CommerceRulesPage() {
  return (
    <PageContent
      title="Commerce Rules"
      titleInfo={{
        title:
          "Versioned commission rules for Shopify products, variants, collections, and promotions.",
      }}
    >
      <PageWidthWrapper className="pb-10">
        <CommerceRulesClient />
      </PageWidthWrapper>
    </PageContent>
  );
}
