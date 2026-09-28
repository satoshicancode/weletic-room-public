import {
  hasRestrictedDevelopmentConfiguration,
  isRestrictedDevelopmentEnvironment,
} from "./restricted-development";
/** Presence is fail-closed, including malformed values. Only the isolated
 * launcher emits "1"; production runtime admission rejects this flag. */
export function isSetupOnly(env = process.env): boolean {
  return env.WELETIC_SETUP_ONLY !== undefined;
}

export class SubscriptionVerificationRequiredError extends Error {
  readonly code = "unavailable";
  constructor() {
    super(
      "A current Shopify subscription verification is required for new benefits.",
    );
  }
}

export function assertNewBenefitsEnabled() {
  if (
    isSetupOnly() ||
    (hasRestrictedDevelopmentConfiguration(process.env) &&
      !isRestrictedDevelopmentEnvironment(process.env))
  )
    throw new SubscriptionVerificationRequiredError();
}
