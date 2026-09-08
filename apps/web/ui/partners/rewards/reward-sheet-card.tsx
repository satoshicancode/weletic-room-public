import { cn } from "@dub/utils";
import { ReactNode } from "react";

export function RewardSheetCard({
  title,
  content,
  className,
}: {
  title: ReactNode;
  content?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-border-subtle rounded-xl border bg-white text-sm shadow-sm",
        className,
      )}
    >
      <div className="text-content-emphasis flex items-center gap-2.5 p-2.5 font-medium">
        {title}
      </div>
      {content && (
        <div className="border-border-subtle -mx-px rounded-xl border-x border-t bg-neutral-50 p-2.5">
          {content}
        </div>
      )}
    </div>
  );
}

export function RewardConnectorLine({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("bg-border-subtle ml-6 h-4 w-px shrink-0", className)}
    />
  );
}
