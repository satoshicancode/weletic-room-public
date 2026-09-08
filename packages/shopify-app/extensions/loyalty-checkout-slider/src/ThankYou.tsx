/** @jsxImportSource preact */
import type { Api } from "@shopify/ui-extensions/purchase.thank-you.block.render";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

declare const shopify: Api;

const API_URL = "https://shopify.weletic.com/api/checkout/loyalty/customer";

type Summary = {
  isEnrolled: boolean;
  account?: { pointsBalance: string; pendingPoints?: string };
};

export default function extension() {
  render(<ThankYouPoints />, document.body);
}

function ThankYouPoints() {
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    shopify.sessionToken
      .get()
      .then((token) =>
        fetch(API_URL, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      )
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => setSummary(payload?.data || payload))
      .catch(() => setSummary(null));
  }, []);

  if (!summary?.isEnrolled) return null;

  const points = Number(summary.account?.pointsBalance || 0).toLocaleString();
  const pending = Number(summary.account?.pendingPoints || 0).toLocaleString();

  return (
    <s-section heading="Your loyalty points">
      <s-text>{points} points available</s-text>
      {pending !== "0" ? <s-text>{pending} points pending</s-text> : null}
    </s-section>
  );
}
