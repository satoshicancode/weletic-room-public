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

export type RestrictedEnvironmentChecker = (env?: NodeJS.ProcessEnv) => boolean;

let restrictedConfigChecker: RestrictedEnvironmentChecker | null = null;
let restrictedChecker: RestrictedEnvironmentChecker | null = null;

export function registerRestrictedChecker(
  hasConfig: RestrictedEnvironmentChecker,
  isEnv: RestrictedEnvironmentChecker,
) {
  restrictedConfigChecker = hasConfig;
  restrictedChecker = isEnv;
}

export function assertNewBenefitsEnabled(env = process.env) {
  if (
    isSetupOnly(env) ||
    (restrictedConfigChecker &&
      restrictedChecker &&
      restrictedConfigChecker(env) &&
      !restrictedChecker(env))
  ) {
    throw new SubscriptionVerificationRequiredError();
  }
}
