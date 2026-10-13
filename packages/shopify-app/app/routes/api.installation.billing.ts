import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createInstallationStatusAction } from "../installation-status-action.server";
import { authenticate, verifyInstallationIdentity } from "../shopify.server";

const handle = createInstallationStatusAction(
  verifyInstallationIdentity,
  true,
  (request) => authenticate.admin(request),
);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
