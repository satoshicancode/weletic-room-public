import type { ActionFunctionArgs } from "@remix-run/node";
import { createMerchantAction } from "../merchant-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

const handle = createMerchantAction(withAuthenticatedMerchant, "create-review");
export const action = ({ request }: ActionFunctionArgs) => handle(request);
