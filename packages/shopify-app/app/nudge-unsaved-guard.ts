import { useBeforeUnload, useBlocker } from "@remix-run/react";
import { useCallback, useEffect } from "react";
import { nudgeCopy } from "../../../apps/web/ui/weletic/loyalty/nudge-copy";

export function useNudgeUnsavedGuard({
  dirty,
  locale,
}: {
  dirty: boolean;
  locale: keyof typeof nudgeCopy;
}) {
  const blocker = useBlocker(dirty);
  useBeforeUnload(
    useCallback(
      (event) => {
        if (!dirty) return;
        event.preventDefault();
        event.returnValue = "";
      },
      [dirty],
    ),
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm(nudgeCopy[locale].leave)) blocker.proceed();
    else blocker.reset();
  }, [blocker, locale]);
}
