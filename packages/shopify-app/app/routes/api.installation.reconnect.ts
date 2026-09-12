import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createInstallationReconnectAction } from "../installation-reconnect-action.server";
import { authenticate, verifyInstallationIdentity } from "../shopify.server";
const handle = createInstallationReconnectAction(
  verifyInstallationIdentity,
  (request) => authenticate.admin(request),
);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
