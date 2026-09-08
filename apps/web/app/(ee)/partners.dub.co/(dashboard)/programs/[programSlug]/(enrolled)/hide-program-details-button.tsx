"use client";

import { useSyncedLocalStorage } from "@/lib/hooks/use-synced-local-storage";
import useProgramEnrollment from "@/lib/swr/use-program-enrollment";
import { Button, Gift, useTranslations } from "@dub/ui";
import { useParams } from "next/navigation";

export function HideProgramDetailsButton() {
  const tCommon = useTranslations("common");
  const { programSlug } = useParams();
  const { programEnrollment } = useProgramEnrollment();

  const [hideDetails, setHideDetails] = useSyncedLocalStorage(
    `hide-program-details:${programSlug}`,
    false,
  );

  if (!programEnrollment?.links?.[0]) {
    return null;
  }

  return (
    <Button
      text={
        hideDetails
          ? tCommon("actions.showDetails") || "Show details"
          : tCommon("actions.hideDetails") || "Hide details"
      }
      icon={<Gift className="size-4" />}
      variant="secondary"
      className="h-8 px-2"
      onClick={() => setHideDetails(!hideDetails)}
    />
  );
}
