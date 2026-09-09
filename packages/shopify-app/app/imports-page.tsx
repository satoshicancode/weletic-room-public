import { useEffect, useMemo, useState } from "react";
import { importsAccessCopy } from "./imports-copy";
import { ImportsScreen } from "./imports-screen";
import { LoyaltyNavigation } from "./loyalty-navigation";
import {
  createMerchantImportContextClient,
  createMerchantImportExecutionClient,
  createMerchantImportHistoryClient,
  createMerchantImportReconciliationClient,
  createMerchantImportsClient,
  createMerchantImportStatusClient,
} from "./merchant-imports-client";

export default function LoyaltyImportsPage({
  shopify,
}: {
  shopify: { idToken: () => Promise<string> };
}) {
  const readLoyalty = useMemo(
    () => createMerchantImportContextClient(() => shopify.idToken()),
    [shopify],
  );
  const [context, setContext] = useState<{
    storeId: string;
    generation: string;
    configure: boolean;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [locale, setLocale] = useState<keyof typeof importsAccessCopy>("en");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setContext(null);
    setFailed(false);
    void readLoyalty()
      .then((result) => {
        if (active)
          setContext({
            storeId: result.storeId,
            generation: result.installationGeneration,
            configure: result.configure,
          });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [readLoyalty, attempt]);
  const request = useMemo(
    () =>
      createMerchantImportsClient(
        () => shopify.idToken(),
        context?.storeId ?? "",
      ),
    [shopify, context?.storeId],
  );
  const execute = useMemo(
    () =>
      createMerchantImportExecutionClient(
        () => shopify.idToken(),
        context?.storeId ?? "",
      ),
    [shopify, context?.storeId],
  );
  const readStatus = useMemo(
    () =>
      createMerchantImportStatusClient(
        () => shopify.idToken(),
        context?.storeId ?? "",
      ),
    [shopify, context?.storeId],
  );
  const readHistory = useMemo(
    () =>
      createMerchantImportHistoryClient(
        () => shopify.idToken(),
        context?.storeId ?? "",
      ),
    [shopify, context?.storeId],
  );
  const reconcile = useMemo(
    () =>
      createMerchantImportReconciliationClient(
        () => shopify.idToken(),
        context?.storeId ?? "",
      ),
    [shopify, context?.storeId],
  );
  return (
    <main className="weletic-shoppers">
      <LoyaltyNavigation />
      {!context && (
        <label>
          Language / 言語 / Ngôn ngữ{" "}
          <select
            value={locale}
            onChange={(event) =>
              setLocale(event.target.value as keyof typeof importsAccessCopy)
            }
          >
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="vi">Tiếng Việt</option>
          </select>
        </label>
      )}
      {context ? (
        <ImportsScreen
          key={`${context.storeId}:${context.generation}`}
          generation={context.generation}
          configure={context.configure}
          request={request}
          readStatus={readStatus}
          readHistory={readHistory}
          reconcile={reconcile}
          execute={execute}
          initialLocale={locale}
        />
      ) : (
        <p role="status">
          {failed
            ? importsAccessCopy[locale].error
            : importsAccessCopy[locale].loading}
        </p>
      )}
      {failed && (
        <button onClick={() => setAttempt(attempt + 1)}>
          {importsAccessCopy[locale].reload}
        </button>
      )}
    </main>
  );
}
