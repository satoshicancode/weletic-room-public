import { PageContent } from "@/ui/layout/page-content";
import { PageWidthWrapper } from "@/ui/layout/page-width-wrapper";
import { ReviewsAdmin } from "@/ui/weletic/reviews/reviews-admin";

export default function ReviewsPage() {
  return (
    <PageContent title="Reviews">
      <PageWidthWrapper className="mb-10">
        <ReviewsAdmin />
      </PageWidthWrapper>
    </PageContent>
  );
}
