import { BlurImage } from "@dub/ui";
import { cn } from "@dub/utils";

export function TokenAvatar({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  return (
    <BlurImage
      src={`https://api.dicebear.com/9.x/shapes/svg?seed=${id}`}
      alt="avatar"
      className={cn("h-10 w-10 rounded-full", className)}
      draggable={false}
    />
  );
}
