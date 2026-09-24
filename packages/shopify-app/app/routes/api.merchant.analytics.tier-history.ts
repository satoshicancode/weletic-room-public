import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantTierHistoryExportAction } from "../merchant-tier-history-export-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

export const action = ({ request }: ActionFunctionArgs) =>
  createMerchantTierHistoryExportAction(withAuthenticatedMerchant)(request);
export const loader = ({ request }: LoaderFunctionArgs) =>
  createMerchantTierHistoryExportAction(withAuthenticatedMerchant)(request);
