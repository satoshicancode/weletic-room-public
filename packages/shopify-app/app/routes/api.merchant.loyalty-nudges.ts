import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantLoyaltyNudgeAction } from "../merchant-loyalty-nudges-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

export const action = ({ request }: ActionFunctionArgs) =>
  createMerchantLoyaltyNudgeAction(withAuthenticatedMerchant)(request);
export const loader = ({ request }: LoaderFunctionArgs) =>
  createMerchantLoyaltyNudgeAction(withAuthenticatedMerchant)(request);
