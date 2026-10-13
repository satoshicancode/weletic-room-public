import {
  TransferPreProcessingContext,
  TransferPreProcessingResult,
  registerTransferPreProcessingHook,
} from "@/lib/partners/transfer-hooks";
import { prisma } from "@/lib/prisma";
import { getWeleticPayoutSettlement } from "@/lib/weletic/payouts/get-settlement";

export async function weleticSettlementHook(
  context: TransferPreProcessingContext,
): Promise<TransferPreProcessingResult> {
  const { allPayouts, withdrawalFee } = context;

  if (allPayouts.some(({ currency }) => currency.toUpperCase() !== "USD")) {
    throw new Error(
      "Automatic Stripe settlement currently requires USD accounting payouts.",
    );
  }

  const settlements = await Promise.all(
    allPayouts.map(({ id }) =>
      getWeleticPayoutSettlement({
        payoutId: id,
        provider: "stripe_connect",
      }),
    ),
  );

  const settlementCurrencies = [
    ...new Set(settlements.map(({ currency }) => currency.toLowerCase())),
  ];
  if (settlementCurrencies.length !== 1 || settlementCurrencies[0] !== "usd") {
    throw new Error(
      "Automatic Stripe settlement is currently limited to USD until cross-border funds flow is certified.",
    );
  }
  const settlementCurrency = settlementCurrencies[0];

  // Minus the withdrawal fee from the total amount
  if (withdrawalFee > 0 && settlementCurrency !== "usd") {
    throw new Error(
      "Forced withdrawals with fees are not supported for non-USD settlement.",
    );
  }

  if (withdrawalFee > 0) {
    const feeSettlement = settlements.at(-1)!;
    const adjustedAmount = feeSettlement.amount - BigInt(withdrawalFee);
    if (adjustedAmount <= BigInt(0)) {
      throw new Error("The Stripe withdrawal fee exceeds the payout amount.");
    }
    await prisma.$transaction(async (tx) => {
      await tx.weleticPayoutQuote.update({
        where: { id: feeSettlement.quoteId },
        data: {
          payoutAmount: adjustedAmount,
          feeAmount: { increment: BigInt(withdrawalFee) },
        },
      });
      const statement = await tx.weleticPayoutStatement.findUnique({
        where: { payoutId: feeSettlement.payoutId },
        select: { snapshot: true },
      });
      if (
        statement?.snapshot &&
        typeof statement.snapshot === "object" &&
        !Array.isArray(statement.snapshot)
      ) {
        await tx.weleticPayoutStatement.update({
          where: { payoutId: feeSettlement.payoutId },
          data: {
            snapshot: {
              ...statement.snapshot,
              payoutAmount: adjustedAmount.toString(),
              feeAmount: withdrawalFee.toString(),
            },
          },
        });
      }
    });
    feeSettlement.amount = adjustedAmount;
  }

  const settlementAmount = settlements.reduce(
    (total, settlement) => total + settlement.amount,
    BigInt(0),
  );
  const finalTransferableAmount = Number(settlementAmount);
  if (!Number.isSafeInteger(finalTransferableAmount)) {
    throw new Error("Stripe settlement amount exceeds the safe integer range.");
  }

  return {
    finalTransferableAmount,
    settlementCurrency,
  };
}

let registered = false;
export function registerWeleticSettlementHook() {
  if (registered) return;
  registered = true;
  registerTransferPreProcessingHook(weleticSettlementHook);
}

// Auto-register upon import
registerWeleticSettlementHook();
