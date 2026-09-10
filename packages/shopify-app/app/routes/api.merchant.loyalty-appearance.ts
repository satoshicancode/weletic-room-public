import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantLoyaltyAppearanceAction } from "../merchant-loyalty-appearance-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

export const action = ({ request }: ActionFunctionArgs) =>
  createMerchantLoyaltyAppearanceAction(withAuthenticatedMerchant)(request);
export const loader = ({ request }: LoaderFunctionArgs) =>
  createMerchantLoyaltyAppearanceAction(withAuthenticatedMerchant)(request);
