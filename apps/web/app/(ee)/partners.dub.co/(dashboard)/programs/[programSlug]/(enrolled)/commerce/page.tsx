import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import {
  WeleticCommerceReportClient,
  WeleticCommerceReportTitle,
} from "./report-client";

export default function WeleticCommerceReportPage() {
  return (
    <PageContent title={<WeleticCommerceReportTitle />}>
      <PageWidthWrapper className="pb-10">
        <WeleticCommerceReportClient />
      </PageWidthWrapper>
    </PageContent>
  );
}
