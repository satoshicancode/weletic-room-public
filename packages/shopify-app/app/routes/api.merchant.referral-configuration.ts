import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantReferralConfigurationAction } from "../merchant-referral-configuration-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

const handle = createMerchantReferralConfigurationAction(
  withAuthenticatedMerchant,
);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
