import { webhookPayloadSchema } from "@/lib/webhook/schemas";
import crypto from "crypto";
import { leadCreated } from "./lead-created";
import { saleCreated } from "./sale-created";

// POST /api/dub/webhook - receive webhooks for Dub
export const POST = async (req: Request) => {
  const webhookSignature = req.headers.get("Dub-Signature");

  if (!webhookSignature || !process.env.DUB_WEBHOOK_SECRET) {
    return new Response("Invalid signature", { status: 400 });
  }

  const rawBody = await req.text();

  const computedSignature = crypto
    .createHmac("sha256", process.env.DUB_WEBHOOK_SECRET || "")
    .update(rawBody)
    .digest("hex");

  if (webhookSignature.length !== computedSignature.length) {
    return new Response("Invalid signature", { status: 400 });
  }

  const sigBuffer = Buffer.from(webhookSignature, "hex");
  const compBuffer = Buffer.from(computedSignature, "hex");

  if (
    sigBuffer.length !== compBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, compBuffer)
  ) {
    return new Response("Invalid signature", { status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const parsed = webhookPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return new Response("Invalid payload", { status: 400 });
  }

  const { event, data } = parsed.data;

  let response = "OK";

  switch (event) {
    case "lead.created": // new signup via referral link (lead event)
      response = await leadCreated(data);
      break;
    case "sale.created": // new sale via referral link (sale event)
      response = await saleCreated(data);
      break;
  }

  return new Response(response);
};
