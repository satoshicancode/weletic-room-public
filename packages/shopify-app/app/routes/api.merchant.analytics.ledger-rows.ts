import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantLedgerRowExportAction } from "../merchant-ledger-row-export-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

export const action = ({ request }: ActionFunctionArgs) =>
  createMerchantLedgerRowExportAction(withAuthenticatedMerchant)(request);
export const loader = ({ request }: LoaderFunctionArgs) =>
  createMerchantLedgerRowExportAction(withAuthenticatedMerchant)(request);
