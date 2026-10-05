import {
  hasRestrictedDevelopmentConfiguration,
  isRestrictedDevelopmentEnvironment,
} from "./restricted-development";
import {
  registerRestrictedChecker,
} from "@weletic/contracts/shopify/setup-only";

registerRestrictedChecker(
  hasRestrictedDevelopmentConfiguration,
  isRestrictedDevelopmentEnvironment,
);

export * from "@weletic/contracts/shopify/setup-only";
