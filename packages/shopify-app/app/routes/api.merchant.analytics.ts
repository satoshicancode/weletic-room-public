import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantAnalyticsAction } from "../merchant-analytics-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

export const action = ({ request }: ActionFunctionArgs) =>
  createMerchantAnalyticsAction(withAuthenticatedMerchant)(request);
export const loader = ({ request }: LoaderFunctionArgs) =>
  createMerchantAnalyticsAction(withAuthenticatedMerchant)(request);
