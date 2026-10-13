import {
  RESTRICTED_DEVELOPMENT,
  getRestrictedDevelopmentConfig,
  getRestrictedDevelopmentStores,
  hasRestrictedDevelopmentConfiguration,
  isRestrictedDevelopmentEnvironment,
} from "../../../../../infra/shopify-development/restricted-policy.mjs";
import { SUBSCRIPTION_VERIFICATION_MS } from "./app-pricing-contract";
export {
  RESTRICTED_DEVELOPMENT,
  getRestrictedDevelopmentConfig,
  getRestrictedDevelopmentStores,
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
  const cfg = getRestrictedDevelopmentConfig(env);
  const stores = getRestrictedDevelopmentStores(env);
  const shopMatches =
    stores.length > 0
      ? stores.includes(identity.shop)
      : identity.shop === cfg.shop;

  return (
    isRestrictedDevelopmentEnvironment(env) &&
    identity.appId === cfg.appId &&
    identity.partnerAppId === cfg.partnerAppId &&
    (!cfg.shopId || identity.shopId === cfg.shopId) &&
    Boolean(cfg.shop || stores.length > 0) &&
    shopMatches &&
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
