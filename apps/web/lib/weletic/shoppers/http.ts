import { ZodError } from "zod";
import { ShopperProfileError } from "./profile-query";

export function shopperJson(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export function shopperHttpError(error: unknown) {
  if (error instanceof ShopperProfileError)
    return shopperJson(
      { error: { code: error.code, message: error.message } },
      error.code === "not_found" ? 404 : 400,
    );
  if (error instanceof ZodError)
    return shopperJson(
      { error: { code: "bad_request", message: "Invalid shopper query" } },
      400,
    );
  return shopperJson(
    {
      error: {
        code: "unavailable",
        message: "Shopper data temporarily unavailable",
      },
    },
    503,
  );
}
