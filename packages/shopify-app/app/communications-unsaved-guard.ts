import { useBeforeUnload, useBlocker } from "@remix-run/react";
import { useCallback, useEffect } from "react";

const prompt = {
  en: "Discard unsaved communications changes and leave this page?",
  ja: "通知の未保存の変更を破棄して、このページを離れますか？",
  vi: "Bỏ các thay đổi thông báo chưa lưu và rời trang này?",
};
export function useCommunicationsUnsavedGuard({
  dirty,
  locale,
}: {
  dirty: boolean;
  locale: keyof typeof prompt;
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
    if (window.confirm(prompt[locale])) blocker.proceed();
    else blocker.reset();
  }, [blocker, locale]);
}
