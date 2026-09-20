/** @jsxImportSource preact */
import type {} from "@shopify/ui-extensions/customer-account.page.render";
import { useEffect, useRef, useState } from "preact/hooks";
import { accountReviewCopy, accountReviewLocale } from "./reviews-copy";
import { reviewProducts, type ReviewProductQuery } from "./reviews-products";

export function ReviewProductPicker({
  queryProducts,
  language,
}: {
  queryProducts: ReviewProductQuery;
  language: string;
}) {
  const copy = accountReviewCopy[accountReviewLocale(language)];
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState<Awaited<
    ReturnType<typeof reviewProducts>
  > | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const busy = useRef(true);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    let current = true;
    busy.current = true;
    setPage(null);
    setFailed(false);
    void reviewProducts(queryProducts, cursor)
      .then((result) => {
        if (current) {
          setPage(result);
          busy.current = false;
        }
      })
      .catch(() => {
        if (current) {
          setFailed(true);
          busy.current = false;
        }
      });
    return () => {
      current = false;
    };
  }, [queryProducts, cursor, retry]);
  return (
    <s-stack direction="block" gap="base">
      <s-heading>{copy.chooseProduct}</s-heading>
      {failed ? (
        <>
          <s-banner tone="critical">{copy.catalogUnavailable}</s-banner>
          <s-button
            onClick={() => {
              if (busy.current) return;
              busy.current = true;
              setRetry((value) => value + 1);
            }}
          >
            {copy.catalogRetry}
          </s-button>
        </>
      ) : !page ? (
        <s-paragraph>{copy.catalogLoading}</s-paragraph>
      ) : (
        <>
          {page.nodes.length === 0 && (
            <s-paragraph>{copy.catalogEmpty}</s-paragraph>
          )}
          {page.nodes.map((product) => (
            <s-button
              key={product.id}
              href={`extension://reviews?view=reviews&productId=${encodeURIComponent(product.id)}`}
            >
              {product.title}
            </s-button>
          ))}
          <s-stack direction="inline" gap="base">
            {cursors.length > 1 && (
              <s-button
                onClick={() => {
                  if (busy.current) return;
                  busy.current = true;
                  setCursors((value) =>
                    value.length > 1 ? value.slice(0, -1) : value,
                  );
                }}
              >
                {copy.previousProducts}
              </s-button>
            )}
            {page.next && (
              <s-button
                onClick={() => {
                  if (busy.current || !page.next) return;
                  busy.current = true;
                  setCursors((value) => [...value, page.next]);
                }}
              >
                {copy.nextProducts}
              </s-button>
            )}
          </s-stack>
        </>
      )}
    </s-stack>
  );
}
