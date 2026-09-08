import { Receiver, SignatureError } from "@upstash/qstash";
import { DubApiError } from "../api/errors";
import { shouldEnforceCronAuth } from "./should-enforce-cron-auth";

// we're using Upstash's Receiver to verify the request signature
// Never substitute QStash's public development keys on an authenticated route.
const receiver = new Receiver({ devMode: false });

export const verifyQstashSignature = async ({
  req,
  rawBody,
}: {
  req: Request;
  rawBody: string; // Make sure to pass the raw body not the parsed JSON
}) => {
  if (!shouldEnforceCronAuth()) {
    return;
  }

  const signature = req.headers.get("Upstash-Signature");

  if (!signature) {
    throw new DubApiError({
      code: "bad_request",
      message: "Upstash-Signature header is required.",
    });
  }

  let isValid: boolean;

  try {
    isValid = await receiver.verify({
      signature,
      body: rawBody,
      // Pass the region header for multi-region support
      upstashRegion: req.headers.get("upstash-region") ?? undefined,
    });
  } catch (error) {
    if (error instanceof SignatureError) {
      throw new DubApiError({
        code: "unauthorized",
        message: "Invalid Upstash-Signature header.",
      });
    }

    throw error;
  }

  if (!isValid) {
    throw new DubApiError({
      code: "unauthorized",
      message: "Invalid Upstash-Signature header.",
    });
  }
};
