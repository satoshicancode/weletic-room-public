/** @jsxImportSource preact */
import type { Api } from "@shopify/ui-extensions/purchase.thank-you.block.render";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

declare const shopify: Api;

const API_URL = "https://shopify.weletic.com/api/checkout/loyalty/customer";

type Summary = {
  points: bigint;
  pending: bigint | null;
};

function exactPoints(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d{0,18})$/.test(value))
    return null;
  const points = BigInt(value);
  return points >= -9223372036854775808n && points <= 9223372036854775807n
    ? points
    : null;
}

/** Keep only the exact balance fields; never retain shopper identity in UI state. */
export function parseThankYouSummary(payload: unknown): Summary | null {
  if (!payload || typeof payload !== "object") return null;
  const data = "data" in payload ? payload.data : payload;
  if (
    !data ||
    typeof data !== "object" ||
    !("isEnrolled" in data) ||
    data.isEnrolled !== true
  )
    return null;
  const account = "account" in data ? data.account : null;
  if (!account || typeof account !== "object") return null;
  const points = exactPoints(
    "pointsBalance" in account ? account.pointsBalance : null,
  );
  if (points === null) return null;
  return {
    points,
    pending: exactPoints(
      "pendingPoints" in account ? account.pendingPoints : null,
    ),
  };
}

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
      .then((payload) => setSummary(parseThankYouSummary(payload)))
      .catch(() => setSummary(null));
  }, []);

  if (!summary) return null;

  const points = shopify.i18n.formatNumber(summary.points);
  const pending =
    summary.pending === null
      ? null
      : shopify.i18n.formatNumber(summary.pending);

  return (
    <s-section heading={shopify.i18n.translate("balanceTitle")}>
      <s-text>{shopify.i18n.translate("balanceAvailable", { points })}</s-text>
      {summary.pending !== null && summary.pending !== 0n ? (
        <s-text>
          {shopify.i18n.translate("balancePending", { points: pending! })}
        </s-text>
      ) : null}
    </s-section>
  );
}
