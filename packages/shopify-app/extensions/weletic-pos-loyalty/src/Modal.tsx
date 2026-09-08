/** @jsxImportSource preact */
import type { Api } from "@shopify/ui-extensions/pos.home.modal.render";
import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

declare const shopify: Api;

type PosReward = {
  id: string;
  name: string;
  description?: string | null;
  rewardType: "amount_off" | "percentage_off";
  salesChannel: "online_store" | "pos" | "both";
  pointsCost: string;
  discountValue?: number | null;
  canRedeem: boolean;
};

type WalletReward = {
  id: string;
  rewardDefinitionId?: string;
  rewardName: string;
  salesChannel?: "online_store" | "pos" | "both";
  artifactKind?: "discount_code" | "gift_card" | "store_credit";
  artifactCode?: string | null;
  discountCode?: string | null;
  status: "available" | "used" | "expired" | "cancelled";
};

type PosSummary = {
  isEnrolled: boolean;
  account?: { pointsBalance: string };
  program?: { currency: string };
  rewards?: PosReward[];
  rewardWallet?: WalletReward[];
};

const redemptionIntentKeys = new Map<string, string>();

function unwrapPayload<T>(payload: { data?: T } | T): T {
  return (
    payload && typeof payload === "object" && "data" in payload
      ? payload.data
      : payload
  ) as T;
}

export function isPosReward(reward: PosReward) {
  return (
    (reward.salesChannel === "pos" || reward.salesChannel === "both") &&
    (reward.rewardType === "amount_off" ||
      reward.rewardType === "percentage_off")
  );
}

export function posWalletArtifactCode(reward: WalletReward) {
  if (reward.artifactKind && reward.artifactKind !== "discount_code") {
    return null;
  }
  return reward.artifactCode || reward.discountCode || null;
}

export function isPosWalletReward(reward: WalletReward) {
  return (
    reward.status === "available" &&
    (reward.salesChannel === "pos" || reward.salesChannel === "both") &&
    Boolean(posWalletArtifactCode(reward))
  );
}

export function formatPosRewardValue(reward: PosReward, currency: string) {
  if (reward.rewardType === "percentage_off") {
    return `${Number(reward.discountValue || 0)}% off`;
  }
  const formatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(
    Number(reward.discountValue || 0) / 10 ** fractionDigits,
  );
}

async function readJson(response: Response) {
  const payload = await response.json();
  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      "POS loyalty request failed";
    throw new Error(message);
  }
  return payload;
}

export function PosLoyaltyModal() {
  const customerId = shopify.cart.current.value.customer?.id;
  const [summary, setSummary] = useState<PosSummary | null>(null);
  const [loading, setLoading] = useState(Boolean(customerId));
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    if (!customerId) return;
    setError(null);
    const response = await fetch(
      `/api/pos/loyalty?customerId=${encodeURIComponent(String(customerId))}`,
    );
    const payload = await readJson(response);
    setSummary(unwrapPayload<PosSummary>(payload));
  }, [customerId]);

  useEffect(() => {
    if (!customerId) return;
    setLoading(true);
    loadSummary()
      .catch((cause) => {
        setError(
          cause instanceof Error ? cause.message : "Unable to load loyalty",
        );
      })
      .finally(() => setLoading(false));
  }, [customerId, loadSummary]);

  async function applyCode(code: string, rewardName: string) {
    await shopify.cart.addCartCodeDiscount(code);
    setMessage(`${rewardName} was applied to the POS cart.`);
  }

  async function redeem(reward: PosReward) {
    if (!customerId) return;
    setWorkingId(reward.id);
    setError(null);
    setMessage(null);
    let idempotencyKey = redemptionIntentKeys.get(reward.id);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      redemptionIntentKeys.set(reward.id, idempotencyKey);
    }

    try {
      const response = await fetch("/api/pos/loyalty", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopifyCustomerId: String(customerId),
          rewardDefinitionId: reward.id,
          idempotencyKey,
        }),
      });
      const payload = await readJson(response);
      const issued = unwrapPayload<{
        success: boolean;
        artifactKind: string;
        artifactCode?: string | null;
        discountCode?: string | null;
      }>(payload);
      const code = issued.artifactCode || issued.discountCode;
      if (issued.artifactKind !== "discount_code" || !code) {
        throw new Error("Shopify POS expected a discount-code reward.");
      }
      redemptionIntentKeys.delete(reward.id);
      try {
        await applyCode(code, reward.name);
      } catch {
        setMessage(
          `${reward.name} was redeemed as ${code}, but POS could not apply it automatically. The code remains in the customer's reward wallet.`,
        );
      }
      await loadSummary().catch(() => undefined);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to redeem reward",
      );
    } finally {
      setWorkingId(null);
    }
  }

  if (!customerId) {
    return (
      <s-page heading="Loyalty rewards">
        <s-banner tone="warning">
          Select a customer on the Shopify POS cart before redeeming points.
        </s-banner>
      </s-page>
    );
  }

  if (loading) {
    return (
      <s-page heading="Loyalty rewards">
        <s-stack direction="block" alignItems="center" gap="base">
          <s-spinner accessibilityLabel="Loading loyalty rewards" />
          <s-text>Loading customer loyalty balance…</s-text>
        </s-stack>
      </s-page>
    );
  }

  if (!summary?.isEnrolled) {
    return (
      <s-page heading="Loyalty rewards">
        <s-banner tone="info">
          This customer is not enrolled in the store loyalty program.
        </s-banner>
      </s-page>
    );
  }

  const rewards = (summary.rewards || []).filter(isPosReward);
  const wallet = (summary.rewardWallet || []).filter(isPosWalletReward);
  const currency = summary.program?.currency || "USD";
  const points = Number(summary.account?.pointsBalance || 0);

  return (
    <s-page
      heading="Loyalty rewards"
      subheading={`${points.toLocaleString()} points available`}
    >
      <s-stack direction="block" gap="base">
        {message ? <s-banner tone="success">{message}</s-banner> : null}
        {error ? <s-banner tone="critical">{error}</s-banner> : null}

        {wallet.length > 0 ? (
          <s-section heading="Ready to use">
            <s-stack direction="block" gap="base">
              {wallet.map((reward) => {
                const code = posWalletArtifactCode(reward) as string;
                return (
                  <s-stack key={reward.id} direction="block" gap="small-200">
                    <s-text type="strong">{reward.rewardName}</s-text>
                    <s-text color="subdued">Code {code}</s-text>
                    <s-button
                      variant="primary"
                      loading={workingId === reward.id}
                      disabled={Boolean(workingId)}
                      onClick={() => {
                        setWorkingId(reward.id);
                        setError(null);
                        applyCode(code, reward.rewardName)
                          .catch((cause) =>
                            setError(
                              cause instanceof Error
                                ? cause.message
                                : "Unable to apply reward",
                            ),
                          )
                          .finally(() => setWorkingId(null));
                      }}
                    >
                      Apply to cart
                    </s-button>
                  </s-stack>
                );
              })}
            </s-stack>
          </s-section>
        ) : null}

        <s-section heading="Redeem points">
          {rewards.length === 0 ? (
            <s-text color="subdued">
              No POS rewards are currently available.
            </s-text>
          ) : (
            <s-stack direction="block" gap="base">
              {rewards.map((reward) => (
                <s-stack key={reward.id} direction="block" gap="small-200">
                  <s-text type="strong">{reward.name}</s-text>
                  {reward.description ? (
                    <s-text color="subdued">{reward.description}</s-text>
                  ) : null}
                  <s-text>
                    {formatPosRewardValue(reward, currency)} ·{" "}
                    {Number(reward.pointsCost).toLocaleString()} points
                  </s-text>
                  <s-button
                    variant="primary"
                    loading={workingId === reward.id}
                    disabled={Boolean(workingId) || !reward.canRedeem}
                    onClick={() => redeem(reward)}
                  >
                    {reward.canRedeem
                      ? "Redeem and apply"
                      : "Not enough points"}
                  </s-button>
                </s-stack>
              ))}
            </s-stack>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export default function extension() {
  render(<PosLoyaltyModal />, document.body);
}
