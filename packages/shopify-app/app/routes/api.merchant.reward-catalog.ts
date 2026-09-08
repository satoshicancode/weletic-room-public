import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantRewardCatalogAction } from "../merchant-reward-catalog-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

const handle = createMerchantRewardCatalogAction(withAuthenticatedMerchant);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
