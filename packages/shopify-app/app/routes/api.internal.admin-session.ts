import { adminSessionResponse } from "../admin-session-response.server";
import { unauthenticated } from "../shopify.server";

export const loader = adminSessionResponse((shop) =>
  unauthenticated.admin(shop),
);
