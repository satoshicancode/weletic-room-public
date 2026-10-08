import {
  vipCampaignRequestSchema,
  vipCampaignResponseSchema,
} from "./vip-campaign-contract";

const canonicalCampaign = (value: {
  eligibleTierIds: string[];
  eligibleSkus: string[];
  eligibleCollectionIds: string[];
}) => ({
  ...value,
  eligibleTierIds: [...value.eligibleTierIds].sort(),
  eligibleSkus: [...value.eligibleSkus].sort(),
  eligibleCollectionIds: [...value.eligibleCollectionIds].sort(),
});

export function verifyVipCampaignAcknowledgement(
  request: unknown,
  response: unknown,
) {
  const input = vipCampaignRequestSchema.parse(request);
  const view = vipCampaignResponseSchema.parse(response);
  if (
    new Set(view.tiers.map(({ id }) => id)).size !== view.tiers.length ||
    new Set(view.campaigns.map(({ id }) => id)).size !== view.campaigns.length
  )
    throw new Error("VIP campaign acknowledgement is unavailable");
  if (input.operation === "read") {
    if (view.affectedResourceId !== null)
      throw new Error("Unexpected mutation acknowledgement");
    return view;
  }
  if (
    view.installationGeneration !==
      input.input.expectedInstallationGeneration ||
    !view.affectedResourceId
  )
    throw new Error("VIP campaign acknowledgement is unavailable");
  if (
    input.operation === "save_policy" &&
    JSON.stringify(view.policy) !== JSON.stringify(input.input.policy)
  )
    throw new Error("VIP policy acknowledgement is unavailable");
  if (
    input.operation === "save_tier" &&
    !view.tiers.some(
      ({ id, fields }) =>
        id === view.affectedResourceId &&
        (input.input.tierId === null || id === input.input.tierId) &&
        JSON.stringify(fields) === JSON.stringify(input.input.tier),
    )
  )
    throw new Error("VIP tier acknowledgement is unavailable");
  if (
    input.operation === "save_campaign" &&
    !view.campaigns.some(
      ({ id, fields }) =>
        id === view.affectedResourceId &&
        (input.input.campaignId === null || id === input.input.campaignId) &&
        JSON.stringify(canonicalCampaign(fields)) ===
          JSON.stringify(canonicalCampaign(input.input.campaign)),
    )
  )
    throw new Error("Campaign acknowledgement is unavailable");
  if (
    input.operation === "retire_tier" &&
    (view.affectedResourceId !== input.input.tierId ||
      view.tiers.some(({ id }) => id === input.input.tierId))
  )
    throw new Error("VIP tier retirement acknowledgement is unavailable");
  if (
    input.operation === "retire_campaign" &&
    (view.affectedResourceId !== input.input.campaignId ||
      view.campaigns.some(({ id }) => id === input.input.campaignId))
  )
    throw new Error("Campaign retirement acknowledgement is unavailable");
  return view;
}
