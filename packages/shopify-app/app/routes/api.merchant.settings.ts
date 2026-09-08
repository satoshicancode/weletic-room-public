import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createMerchantSettingsAction } from "../merchant-settings-action.server";
import { withAuthenticatedMerchant } from "../shopify.server";

const handle = createMerchantSettingsAction(withAuthenticatedMerchant);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
