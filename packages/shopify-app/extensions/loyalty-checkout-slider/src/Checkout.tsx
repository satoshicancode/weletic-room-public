/** @jsxImportSource preact */
import type { Api } from "@shopify/ui-extensions/purchase.checkout.reductions.render-after";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

declare const shopify: Api;

const API_BASE_URL = "https://shopify.weletic.com/api/checkout/loyalty";

type IncrementalReward = {
  id: string;
  name: string;
  exchangeType: "incremental";
  pointsCost: string;
  pointsStep: string | null;
  minPointsCost: string | null;
  maxPointsCost: string | null;
};

type Summary = {
  isEnrolled: boolean;
  account?: { pointsBalance: string };
  rewards?: IncrementalReward[];
};

async function authenticatedRequest(path: string, init?: RequestInit) {
  const token = await shopify.sessionToken.get();
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

export default function extension() {
  render(<LoyaltyCheckoutSlider />, document.body);
}

export function LoyaltyCheckoutSlider() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [selectedPoints, setSelectedPoints] = useState(0);
  const [reservation, setReservation] = useState<{
    reservationId: string;
    discountCode: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkoutToken = shopify.checkoutToken.value;
  useEffect(() => {
    authenticatedRequest("/customer")
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error?.message || "Unable to load points");
        }
        setSummary(payload.data || payload);
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Unable to load points",
        ),
      );
  }, []);

  const reward = useMemo(
    () =>
      summary?.rewards?.find(
        (candidate) =>
          candidate.exchangeType === "incremental" && candidate.pointsStep,
      ) || null,
    [summary],
  );
  const balance = Number(summary?.account?.pointsBalance || 0);
  const step = Number(reward?.pointsStep || 1);
  const minimum = Number(reward?.minPointsCost || reward?.pointsCost || step);
  const configuredMaximum = reward?.maxPointsCost
    ? Number(reward.maxPointsCost)
    : balance;
  const maximum =
    Math.floor(Math.min(balance, configuredMaximum) / step) * step;

  useEffect(() => {
    if (reward && maximum >= minimum && selectedPoints === 0) {
      setSelectedPoints(minimum);
    }
  }, [maximum, minimum, reward, selectedPoints]);

  async function reserve() {
    if (!reward || !checkoutToken || selectedPoints <= 0) return;
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedRequest("/checkout/reserve", {
        method: "POST",
        body: JSON.stringify({
          rewardDefinitionId: reward.id,
          pointsRequested: String(selectedPoints),
          checkoutToken,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message || "Unable to reserve points");
      }
      const data = payload.data || payload;
      const applyResult = await shopify.applyDiscountCodeChange({
        type: "addDiscountCode",
        code: data.discountCode,
      });
      if (applyResult.type === "error") {
        await authenticatedRequest("/checkout/release", {
          method: "POST",
          body: JSON.stringify({ reservationId: data.reservationId }),
        });
        throw new Error("Shopify could not apply the loyalty discount.");
      }
      setReservation(data);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to redeem points",
      );
    } finally {
      setLoading(false);
    }
  }

  async function release() {
    if (!reservation) return;
    setLoading(true);
    setError(null);
    try {
      const removeResult = await shopify.applyDiscountCodeChange({
        type: "removeDiscountCode",
        code: reservation.discountCode,
      });
      if (removeResult.type === "error") {
        throw new Error("Shopify could not remove the loyalty discount.");
      }
      const response = await authenticatedRequest("/checkout/release", {
        method: "POST",
        body: JSON.stringify({ reservationId: reservation.reservationId }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload?.error?.message || "Unable to restore points");
      }
      setReservation(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to remove discount",
      );
    } finally {
      setLoading(false);
    }
  }

  if (error && !summary) return <s-banner tone="critical">{error}</s-banner>;
  if (!summary?.isEnrolled) return null;
  if (!reward || !checkoutToken || maximum < minimum) return null;
  if (!shopify.instructions.value.discounts.canUpdateDiscountCodes) {
    return (
      <s-banner tone="warning">Loyalty discounts are unavailable.</s-banner>
    );
  }

  return (
    <s-section heading="Redeem loyalty points">
      <s-text>{balance.toLocaleString()} points available</s-text>
      {error ? <s-banner tone="critical">{error}</s-banner> : null}
      {reservation ? (
        <s-banner tone="success">
          {selectedPoints.toLocaleString()} points applied.
          <s-button disabled={loading} onClick={release}>
            Remove
          </s-button>
        </s-banner>
      ) : (
        <>
          <s-number-field
            label="Points to redeem"
            min={minimum}
            max={maximum}
            step={step}
            value={String(selectedPoints)}
            onInput={(event) => {
              const field = event.currentTarget as
                | (EventTarget & { value?: string })
                | null;
              setSelectedPoints(Number(field?.value || minimum));
            }}
          />
          <s-button disabled={loading} loading={loading} onClick={reserve}>
            Apply points
          </s-button>
        </>
      )}
    </s-section>
  );
}
