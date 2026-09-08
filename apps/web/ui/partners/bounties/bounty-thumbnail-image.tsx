import { BountyProps } from "@/lib/types";
import { BlurImage } from "@dub/ui";
import { cn } from "@dub/utils";

export function BountyThumbnailImage({
  bounty,
  className,
}: {
  bounty: Pick<BountyProps, "type">;
  className?: string;
}) {
  const isPerformance = bounty.type === "performance";
  return (
    <BlurImage
      src={
        isPerformance
          ? "https://assets.dub.co/icons/trophy.webp"
          : "https://assets.dub.co/icons/heart.webp"
      }
      alt={isPerformance ? "Trophy thumbnail" : "Heart thumbnail"}
      className={cn("size-full object-contain", className)}
    />
  );
}
