import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantVipCampaignAction } from "../merchant-vip-campaign-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

const handle = createMerchantVipCampaignAction(withAuthenticatedMerchant);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
