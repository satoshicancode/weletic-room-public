/** @jsxImportSource preact */
import type { Api } from "@shopify/ui-extensions/customer-account.profile.block.render";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

declare const shopify: Api;

const API_BASE_URL = "https://shopify.weletic.com/api/customer-account/loyalty";
const LOYALTY_PAGE_URL = "extension:weletic-loyalty-customer-account-hub/";
const CUSTOMER_REQUEST_TIMEOUT_MS = 10_000;

type ProfileLoyaltySummary = {
  isEnrolled: boolean;
  account?: { pointsBalance: string };
  tier?: { currentTier?: { name?: string } };
  rewardWallet?: Array<{ status: string }>;
};

export function availableRewardCount(summary: ProfileLoyaltySummary) {
  return (summary.rewardWallet || []).filter(
    (reward) => reward.status === "available",
  ).length;
}

export function ProfileLoyaltySummaryView({
  summary,
}: {
  summary: ProfileLoyaltySummary;
}) {
  const points = Number(summary.account?.pointsBalance || "0");
  const tier = summary.tier?.currentTier?.name || "Member";
  const availableRewards = availableRewardCount(summary);
  const rewardsLabel = `${availableRewards} available ${
    availableRewards === 1 ? "reward" : "rewards"
  }`;

  return (
    <s-section heading="Rewards">
      <s-button
        slot="primary-action"
        href={LOYALTY_PAGE_URL}
        variant="secondary"
      >
        View Loyalty Hub
      </s-button>
      <s-stack direction="block" gap="small-200">
        <s-heading>{points.toLocaleString()} points</s-heading>
        <s-text color="subdued">
          {tier} · {rewardsLabel}
        </s-text>
      </s-stack>
    </s-section>
  );
}

export default function extension() {
  render(<CustomerAccountLoyaltyProfileBlock />, document.body);
}

export function CustomerAccountLoyaltyProfileBlock() {
  const [summary, setSummary] = useState<ProfileLoyaltySummary | null>(null);
  const [error, setError] = useState(false);

  async function loadSummary() {
    setError(false);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("Rewards request timed out"));
      }, CUSTOMER_REQUEST_TIMEOUT_MS);
    });

    try {
      const requestPromise = (async () => {
        const token = await shopify.sessionToken.get();
        return fetch(`${API_BASE_URL}/customer`, {
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });
      })();
      const response = await Promise.race([requestPromise, timeoutPromise]);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message || "Unable to load rewards");
      }
      setSummary(payload.data || payload);
    } catch {
      setError(true);
    } finally {
      clearTimeout(timeout!);
    }
  }

  useEffect(() => {
    void loadSummary();
  }, []);

  if (error) {
    return (
      <s-section heading="Rewards">
        <s-button
          slot="primary-action"
          href={LOYALTY_PAGE_URL}
          variant="secondary"
        >
          View Loyalty Hub
        </s-button>
        <s-stack direction="block" gap="small-200">
          <s-text color="subdued">Rewards are temporarily unavailable.</s-text>
          <s-button onClick={loadSummary} variant="secondary">
            Try again
          </s-button>
        </s-stack>
      </s-section>
    );
  }

  if (!summary) {
    return (
      <s-section heading="Rewards">
        <s-skeleton-paragraph content="0 points · Member · 0 available rewards" />
      </s-section>
    );
  }

  if (!summary.isEnrolled) {
    return (
      <s-section heading="Rewards">
        <s-button
          slot="primary-action"
          href={LOYALTY_PAGE_URL}
          variant="secondary"
        >
          View Loyalty Hub
        </s-button>
        <s-text color="subdued">
          Join the rewards program to start earning points.
        </s-text>
      </s-section>
    );
  }

  return <ProfileLoyaltySummaryView summary={summary} />;
}
