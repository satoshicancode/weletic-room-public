import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantImportsAction } from "../merchant-imports-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

export const action = ({ request }: ActionFunctionArgs) =>
  createMerchantImportsAction(withAuthenticatedMerchant)(request);
export const loader = ({ request }: LoaderFunctionArgs) =>
  createMerchantImportsAction(withAuthenticatedMerchant)(request);
