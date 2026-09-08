import type {
  EmojiPickerListCategoryHeaderProps,
  EmojiPickerListEmojiProps,
  EmojiPickerListRowProps,
} from "frimousse";
import { useMemo } from "react";
import { adaptReactRef } from "./compatible-react-ref";

export function EmojiPickerCategoryHeader({
  category,
  ref,
  ...props
}: EmojiPickerListCategoryHeaderProps) {
  const compatibleRef = useMemo(
    () => adaptReactRef<HTMLDivElement>(ref),
    [ref],
  );
  return (
    <div
      className="text-content-subtle bg-white px-3 pb-1.5 pt-3 text-xs font-medium"
      {...props}
      ref={compatibleRef}
    >
      {category.label}
    </div>
  );
}

export function EmojiPickerRow({
  children,
  ref,
  ...props
}: EmojiPickerListRowProps) {
  const compatibleRef = useMemo(
    () => adaptReactRef<HTMLDivElement>(ref),
    [ref],
  );
  return (
    <div className="scroll-my-1.5 px-1.5" {...props} ref={compatibleRef}>
      {children}
    </div>
  );
}

export function EmojiPickerEmoji({
  emoji,
  ref,
  ...props
}: EmojiPickerListEmojiProps) {
  const compatibleRef = useMemo(
    () => adaptReactRef<HTMLButtonElement>(ref),
    [ref],
  );
  return (
    <button
      className="flex size-7 items-center justify-center rounded-md text-lg data-[active]:bg-neutral-100"
      {...props}
      ref={compatibleRef}
    >
      {emoji.emoji}
    </button>
  );
}
