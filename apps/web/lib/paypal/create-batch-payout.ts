import { createPaypalToken } from "@/lib/paypal/create-paypal-token";
import { paypalEnv } from "@/lib/paypal/env";
import { minorUnitsToDecimal } from "@/lib/weletic/money";
import { getWeleticPayoutSettlement } from "@/lib/weletic/payouts/get-settlement";
import { Partner, Payout, Program } from "@prisma/client";

interface CreatePayPalBatchPayout {
  payouts: (Pick<Payout, "id" | "amount"> & {
    partner: Pick<Partner, "paypalEmail">;
    program: Pick<Program, "name">;
  })[];
  invoiceId: string;
}

export interface PayPalBatchResult {
  currency: string;
  senderBatchId: string;
  payoutBatchId?: string;
  batchStatus?: string;
  payoutIds: string[];
  success: boolean;
  error?: string;
  data?: any;
}

export interface CreatePayPalBatchPayoutResponse {
  results: PayPalBatchResult[];
  successfulPayoutIds: string[];
  failedPayoutIds: string[];
}

// Create a batch payout for an array of payouts for a program, separated by settlement currency
export async function createPayPalBatchPayout({
  payouts,
  invoiceId,
}: CreatePayPalBatchPayout): Promise<CreatePayPalBatchPayoutResponse> {
  const paypalAccessToken = await createPaypalToken();
  const settlements = await Promise.all(
    payouts.map(({ id }) =>
      getWeleticPayoutSettlement({ payoutId: id, provider: "paypal" }),
    ),
  );
  const settlementByPayoutId = new Map(
    settlements.map((settlement) => [settlement.payoutId, settlement]),
  );

  const items = payouts.map((payout) => {
    if (!payout.partner.paypalEmail) {
      throw new Error(`Payout ${payout.id} has no PayPal destination.`);
    }
    const settlement = settlementByPayoutId.get(payout.id);
    if (!settlement) throw new Error(`Missing payout quote for ${payout.id}.`);
    return {
      payoutId: payout.id,
      recipient_type: "EMAIL",
      receiver: payout.partner.paypalEmail,
      sender_item_id: payout.id,
      note: `Dub Partners payout (${payout.program.name})`,
      amount: {
        value: minorUnitsToDecimal(settlement.amount, settlement.currency),
        currency: settlement.currency,
      },
    };
  });

  const itemsByCurrency = new Map<string, typeof items>();
  for (const item of items) {
    itemsByCurrency.set(item.amount.currency, [
      ...(itemsByCurrency.get(item.amount.currency) ?? []),
      item,
    ]);
  }

  const batchPromises = [...itemsByCurrency].map(
    async ([currency, currencyItems]): Promise<PayPalBatchResult> => {
      const senderBatchId = `${invoiceId}:${currency.toLowerCase()}`;
      const payoutIds = currencyItems.map((i) => i.payoutId);
      try {
        const response = await fetch(
          `${paypalEnv.PAYPAL_API_HOST}/v1/payments/payouts`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${paypalAccessToken}`,
            },
            body: JSON.stringify({
              sender_batch_header: { sender_batch_id: senderBatchId },
              items: currencyItems.map(({ payoutId: _, ...item }) => item),
            }),
          },
        );

        const data = await response.json();
        if (!response.ok) {
          console.error("[PayPal] Batch payout creation failed", data);
          return {
            currency,
            senderBatchId,
            payoutIds,
            success: false,
            error: `[PayPal] Batch payout creation failed for ${currency}. Batch ID: ${senderBatchId}. Error: ${JSON.stringify(data)}`,
            data,
          };
        }

        console.log("[PayPal] Batch payout created", data);
        return {
          currency,
          senderBatchId,
          payoutBatchId: data.batch_header?.payout_batch_id,
          batchStatus: data.batch_header?.batch_status,
          payoutIds,
          success: true,
          data,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          currency,
          senderBatchId,
          payoutIds,
          success: false,
          error: message,
        };
      }
    },
  );

  const results = await Promise.all(batchPromises);
  const successfulPayoutIds = results
    .filter((r) => r.success)
    .flatMap((r) => r.payoutIds);
  const failedPayoutIds = results
    .filter((r) => !r.success)
    .flatMap((r) => r.payoutIds);

  return {
    results,
    successfulPayoutIds,
    failedPayoutIds,
  };
}
