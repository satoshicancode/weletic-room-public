import { useCallback, useEffect, useRef, useState } from "react";

export const useCopyToClipboard = (
  timeout: number = 3000,
): [
  boolean,
  (
    value: string | ClipboardItem,
    options?: { onSuccess?: () => void; throwOnError?: boolean },
  ) => Promise<void>,
] => {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const copyToClipboard = useCallback(
    async (
      value: string | ClipboardItem,
      {
        onSuccess,
        throwOnError = false,
      }: { onSuccess?: () => void; throwOnError?: boolean } = {},
    ) => {
      clearTimer();
      let copiedSuccessfully = false;

      try {
        if (typeof window !== "undefined" && navigator?.clipboard) {
          try {
            if (typeof value === "string") {
              await navigator.clipboard.writeText(value);
              copiedSuccessfully = true;
            } else if (value instanceof ClipboardItem) {
              await navigator.clipboard.write([value]);
              copiedSuccessfully = true;
            }
          } catch {
            // Clipboard API may throw NotAllowedError when document is not focused
          }
        }

        // Fallback for text copying when Clipboard API fails or document is not focused
        if (
          !copiedSuccessfully &&
          typeof value === "string" &&
          typeof document !== "undefined"
        ) {
          try {
            const textArea = document.createElement("textarea");
            textArea.value = value;
            textArea.style.position = "fixed";
            textArea.style.left = "-999999px";
            textArea.style.top = "-999999px";
            textArea.setAttribute("readonly", "");
            document.body.appendChild(textArea);
            textArea.select();
            copiedSuccessfully = document.execCommand("copy");
            document.body.removeChild(textArea);
          } catch {
            // Ignore fallback errors
          }
        }

        if (copiedSuccessfully) {
          setCopied(true);
          onSuccess?.();

          // Ensure timeout is a non-negative finite number
          if (Number.isFinite(timeout) && timeout >= 0) {
            timer.current = setTimeout(() => setCopied(false), timeout);
          }
        }
      } catch (error) {
        if (throwOnError) {
          throw error;
        }
      }
    },
    [timeout],
  );

  // Cleanup the timer when the component unmounts
  useEffect(() => {
    return () => clearTimer();
  }, []);

  return [copied, copyToClipboard];
};
