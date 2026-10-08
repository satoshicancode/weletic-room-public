import { registerRestrictedChecker } from "@weletic/contracts/shopify/setup-only";
import {
  hasRestrictedDevelopmentConfiguration,
  isRestrictedDevelopmentEnvironment,
} from "./restricted-development";

registerRestrictedChecker(
  hasRestrictedDevelopmentConfiguration,
  isRestrictedDevelopmentEnvironment,
);

export * from "@weletic/contracts/shopify/setup-only";
