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

type ProfileLocaleApi = {
  formatNumber: (value: number | bigint) => string;
  translate: (
    key: string,
    replacements?: Record<string, string | number>,
  ) => string;
};

export function parseProfilePoints(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d{0,18})$/.test(value))
    return null;
  const points = BigInt(value);
  return points >= BigInt("-9223372036854775808") &&
    points <= BigInt("9223372036854775807")
    ? points
    : null;
}

export function availableRewardCount(summary: ProfileLoyaltySummary) {
  return (summary.rewardWallet || []).filter(
    (reward) => reward.status === "available",
  ).length;
}

export function ProfileLoyaltySummaryView({
  summary,
  i18n = shopify.i18n,
}: {
  summary: ProfileLoyaltySummary;
  i18n?: ProfileLocaleApi;
}) {
  const rawPoints = parseProfilePoints(summary.account?.pointsBalance);
  const points =
    rawPoints === null
      ? i18n.translate("pointsUnavailable")
      : i18n.translate("points", { points: i18n.formatNumber(rawPoints) });
  const tier = summary.tier?.currentTier?.name || i18n.translate("member");
  const availableRewards = availableRewardCount(summary);
  const rewardsLabel = i18n.translate(
    availableRewards === 1 ? "rewardOne" : "rewardMany",
    { formattedCount: i18n.formatNumber(availableRewards) },
  );

  return (
    <s-section heading={i18n.translate("rewards")}>
      <s-button
        slot="primary-action"
        href={LOYALTY_PAGE_URL}
        variant="secondary"
      >
        {i18n.translate("viewHub")}
      </s-button>
      <s-stack direction="block" gap="small-200">
        <s-heading>{points}</s-heading>
        <s-text color="subdued">
          {i18n.translate("summary", { tier, rewards: rewardsLabel })}
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
      <s-section heading={shopify.i18n.translate("rewards")}>
        <s-button
          slot="primary-action"
          href={LOYALTY_PAGE_URL}
          variant="secondary"
        >
          {shopify.i18n.translate("viewHub")}
        </s-button>
        <s-stack direction="block" gap="small-200">
          <s-text color="subdued">
            {shopify.i18n.translate("unavailable")}
          </s-text>
          <s-button onClick={loadSummary} variant="secondary">
            {shopify.i18n.translate("retry")}
          </s-button>
        </s-stack>
      </s-section>
    );
  }

  if (!summary) {
    return (
      <s-section heading={shopify.i18n.translate("rewards")}>
        <s-skeleton-paragraph content={shopify.i18n.translate("loading")} />
      </s-section>
    );
  }

  if (!summary.isEnrolled) {
    return (
      <s-section heading={shopify.i18n.translate("rewards")}>
        <s-button
          slot="primary-action"
          href={LOYALTY_PAGE_URL}
          variant="secondary"
        >
          {shopify.i18n.translate("viewHub")}
        </s-button>
        <s-text color="subdued">{shopify.i18n.translate("join")}</s-text>
      </s-section>
    );
  }

  return <ProfileLoyaltySummaryView summary={summary} />;
}
