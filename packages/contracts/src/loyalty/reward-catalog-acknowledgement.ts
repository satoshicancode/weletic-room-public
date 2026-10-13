import {
  rewardCatalogRequestSchema,
  rewardCatalogResponseSchema,
  type RewardCatalogFields,
} from "./reward-catalog-contract";

const canonical = (fields: RewardCatalogFields) =>
  JSON.stringify({
    ...fields,
    discountValue: fields.discountValue?.includes(".")
      ? fields.discountValue.replace(/0+$/, "").replace(/\.$/, "")
      : fields.discountValue,
  });
export function verifyRewardCatalogAcknowledgement(
  request: unknown,
  response: unknown,
) {
  const input = rewardCatalogRequestSchema.parse(request);
  const view = rewardCatalogResponseSchema.parse(response);
  if (
    new Set(view.rewards.map((reward) => reward.id)).size !==
    view.rewards.length
  )
    throw new Error("Reward catalog acknowledgement is unavailable");
  if (input.operation === "read") {
    if (view.affectedRewardId !== null)
      throw new Error("Unexpected mutation acknowledgement");
  } else if (input.operation === "contain") {
    const saved = view.rewards.find(
      (reward) => reward.id === input.input.rewardId,
    );
    if (
      !saved ||
      view.affectedRewardId !== input.input.rewardId ||
      view.installationGeneration !==
        input.input.expectedInstallationGeneration ||
      saved.status !== input.input.status
    )
      throw new Error("Reward containment acknowledgement is unavailable");
  } else {
    const saved = view.rewards.find(
      (reward) => reward.id === view.affectedRewardId,
    );
    if (
      !view.affectedRewardId ||
      view.installationGeneration !==
        input.input.expectedInstallationGeneration ||
      (input.input.rewardId !== null &&
        view.affectedRewardId !== input.input.rewardId) ||
      !saved?.fields ||
      canonical(saved.fields) !== canonical(input.input.reward) ||
      saved.name !== saved.fields.name ||
      saved.status !== saved.fields.status ||
      saved.rewardType !== saved.fields.rewardType
    )
      throw new Error("Reward catalog acknowledgement is unavailable");
  }
  return view;
}
