import { ZodError } from "zod";
import { ReviewError } from "./contracts";

export function reviewJson(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export function reviewHttpError(error: unknown) {
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return reviewJson(
      { error: { code: "bad_request", message: "Invalid review input" } },
      400,
    );
  }
  if (error instanceof ReviewError) {
    const statuses = {
      not_found: 404,
      conflict: 409,
      bad_request: 400,
      disabled: 403,
      unavailable: 503,
    };
    return reviewJson(
      { error: { code: error.code, message: error.message } },
      statuses[error.code],
    );
  }
  // Never log submission bodies, tokens, recipient addresses, or storage URLs.
  return reviewJson(
    {
      error: {
        code: "unavailable",
        message: "Reviews are temporarily unavailable",
      },
    },
    503,
  );
}
