import { withWorkspace } from "@/lib/auth";
import { readMerchantShopperProfile } from "@/lib/weletic/shoppers/profile";
import { ShopperProfileError } from "@/lib/weletic/shoppers/profile-query";
import { ZodError } from "zod";

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export const GET = withWorkspace(
  async ({ workspace, searchParams }) => {
    try {
      return json(await readMerchantShopperProfile(workspace.id, searchParams));
    } catch (error) {
      if (error instanceof ShopperProfileError)
        return json(
          { error: { code: error.code, message: error.message } },
          error.code === "not_found" ? 404 : 400,
        );
      if (error instanceof ZodError)
        return json(
          {
            error: {
              code: "bad_request",
              message: "Invalid shopper profile query",
            },
          },
          400,
        );
      // Do not expose SQL, customer identifiers or secret-bearing provider errors.
      return json(
        {
          error: {
            code: "unavailable",
            message: "Shopper profile temporarily unavailable",
          },
        },
        503,
      );
    }
  },
  { requiredPermissions: ["loyalty.read"] },
);
