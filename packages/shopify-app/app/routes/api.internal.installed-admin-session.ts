import { adminSessionResponse } from "../admin-session-response.server";
import { installedUnauthenticated } from "../shopify.server";

export const loader = adminSessionResponse(
  (shop, generation) => installedUnauthenticated.admin(shop, generation!),
  true,
);
