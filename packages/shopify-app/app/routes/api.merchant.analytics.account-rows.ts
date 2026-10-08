import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantAccountRowExportAction } from "../merchant-account-row-export-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

export const action = ({ request }: ActionFunctionArgs) =>
  createMerchantAccountRowExportAction(withAuthenticatedMerchant)(request);
export const loader = ({ request }: LoaderFunctionArgs) =>
  createMerchantAccountRowExportAction(withAuthenticatedMerchant)(request);
