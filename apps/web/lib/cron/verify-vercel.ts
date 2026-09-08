import { DubApiError } from "../api/errors";
import { shouldEnforceCronAuth } from "./should-enforce-cron-auth";

export const verifyVercelSignature = async (req: Request) => {
  if (!shouldEnforceCronAuth()) {
    return;
  }

  const authHeader = req.headers.get("authorization");

  if (!authHeader) {
    throw new DubApiError({
      code: "unauthorized",
      message: "Vercel Authorization header is required.",
    });
  }

  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    throw new DubApiError({
      code: "internal_server_error",
      message: "CRON_SECRET environment variable is not set.",
    });
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    throw new DubApiError({
      code: "unauthorized",
      message: "Invalid Vercel Authorization header.",
    });
  }
};
