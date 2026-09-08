import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantLoyaltyConfigurationAction } from "../merchant-loyalty-configuration-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

const handle = createMerchantLoyaltyConfigurationAction(
  withAuthenticatedMerchant,
);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
