import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantAction } from "../merchant-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

const handle = createMerchantAction(
  withAuthenticatedMerchant,
  "moderate-review",
);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
