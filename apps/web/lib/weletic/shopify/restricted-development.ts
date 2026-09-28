import {
  RESTRICTED_DEVELOPMENT,
  hasRestrictedDevelopmentConfiguration,
  isRestrictedDevelopmentEnvironment,
} from "../../../../../infra/shopify-development/restricted-policy.mjs";
import { SUBSCRIPTION_VERIFICATION_MS } from "./app-pricing-contract";
export {
  RESTRICTED_DEVELOPMENT,
  hasRestrictedDevelopmentConfiguration,
  isRestrictedDevelopmentEnvironment,
};

export function permitsRestrictedDevelopmentIdentity(
  identity: {
    appId: string;
    partnerAppId: string;
    shopId: string;
    shop: string;
    installationGeneration: string;
  },
  env = process.env,
) {
  return (
    isRestrictedDevelopmentEnvironment(env) &&
    identity.appId === RESTRICTED_DEVELOPMENT.appId &&
    identity.partnerAppId === RESTRICTED_DEVELOPMENT.partnerAppId &&
    identity.shopId === RESTRICTED_DEVELOPMENT.shopId &&
    identity.shop === RESTRICTED_DEVELOPMENT.shop &&
    identity.installationGeneration ===
      env.WELETIC_RESTRICTED_DEVELOPMENT_GENERATION
  );
}

export function hasFreshRestrictedDevelopmentAccess(
  row: {
    appId: string;
    partnerAppId: string;
    shopId: string | null;
    installationGeneration: string;
    status: string;
    planHandle: string | null;
    verifiedAt: Date | null;
    validUntil: Date | null;
    cycleEndsAt: Date | null;
    cancelAtEndOfCycle: boolean;
  },
  shop: string,
  generation: string,
  now: Date,
) {
  return (
    row.status === "restricted_development" &&
    row.shopId !== null &&
    row.installationGeneration === generation &&
    permitsRestrictedDevelopmentIdentity({
      ...row,
      shopId: row.shopId,
      shop,
    }) &&
    row.planHandle === null &&
    row.cycleEndsAt === null &&
    !row.cancelAtEndOfCycle &&
    row.verifiedAt !== null &&
    row.validUntil !== null &&
    Number.isFinite(now.getTime()) &&
    row.verifiedAt <= now &&
    row.validUntil > now &&
    row.validUntil.getTime() - row.verifiedAt.getTime() <=
      SUBSCRIPTION_VERIFICATION_MS
  );
}
