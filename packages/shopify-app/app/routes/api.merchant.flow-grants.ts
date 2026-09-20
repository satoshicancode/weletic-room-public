import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantFlowGrantsAction } from "../merchant-flow-grants-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";
const handle = createMerchantFlowGrantsAction(withAuthenticatedMerchant);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
