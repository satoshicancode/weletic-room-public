import {
  canonicalReferralFields,
  referralConfigurationRequestSchema,
  referralConfigurationResponseSchema,
} from "./referral-configuration-contract";
export function verifyReferralConfigurationAcknowledgement(
  request: unknown,
  response: unknown,
) {
  const input = referralConfigurationRequestSchema.parse(request);
  const view = referralConfigurationResponseSchema.parse(response);
  if (
    view.acknowledgedOperation !== input.operation ||
    new Set(view.couponOptions.map((row) => row.id)).size !==
      view.couponOptions.length
  )
    throw new Error("Invalid referral acknowledgement");
  if (
    input.operation !== "read" &&
    view.installationGeneration !== input.input.expectedInstallationGeneration
  )
    throw new Error("Installation changed");
  if (input.operation === "pause" && view.active)
    throw new Error("Pause not acknowledged");
  if (
    input.operation === "save" &&
    (!view.ruleId ||
      (input.input.ruleId !== null && input.input.ruleId !== view.ruleId) ||
      !view.fields ||
      view.active !== input.input.fields.isActive ||
      JSON.stringify(canonicalReferralFields(view.fields)) !==
        JSON.stringify(canonicalReferralFields(input.input.fields)))
  )
    throw new Error("Referral save not acknowledged");
  return view;
}
