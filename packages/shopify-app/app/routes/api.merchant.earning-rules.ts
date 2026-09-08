import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantEarningRulesAction } from "../merchant-earning-rules-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

const handle = createMerchantEarningRulesAction(withAuthenticatedMerchant);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
