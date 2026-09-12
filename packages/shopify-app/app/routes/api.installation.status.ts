import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { createInstallationStatusAction } from "../installation-status-action.server";
import { verifyInstallationIdentity } from "../shopify.server";

const handle = createInstallationStatusAction(verifyInstallationIdentity);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
