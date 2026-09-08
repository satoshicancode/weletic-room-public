import { prisma } from "@/lib/prisma";
import { createWeleticPayoutQuote } from "@/lib/weletic/payouts/create-quote";
import { assertPayoutProviderCompatibility } from "@/lib/weletic/payouts/providers";

export async function getWeleticPayoutSettlement({
  payoutId,
  provider,
}: {
  payoutId: string;
  provider: "stripe_connect" | "paypal";
}) {
  const quote = await createWeleticPayoutQuote({
    payoutId,
    payoutProvider: provider,
  });
  if (quote.provider !== provider || !quote.payoutProfileId) {
    throw new Error(
      `Payout ${payoutId} requires a verified ${provider} payout profile before settlement.`,
    );
  }
  if (quote.expiresAt && quote.expiresAt <= new Date()) {
    throw new Error(`Payout quote ${quote.id} expired before settlement.`);
  }
  const boundAccount = await prisma.weleticPayoutQuote.findUniqueOrThrow({
    where: { id: quote.id },
    select: {
      profile: {
        select: {
          method: true,
          payoutCurrency: true,
          providerAccountRef: true,
        },
      },
      payout: {
        select: {
          partner: {
            select: { stripeConnectId: true, paypalEmail: true },
          },
        },
      },
    },
  });
  const currentAccount =
    provider === "stripe_connect"
      ? boundAccount.payout.partner.stripeConnectId
      : boundAccount.payout.partner.paypalEmail;
  if (
    !currentAccount ||
    boundAccount.profile?.providerAccountRef !== currentAccount
  ) {
    throw new Error(
      `Payout profile for ${payoutId} must be re-verified after the connected account changed.`,
    );
  }
  assertPayoutProviderCompatibility({
    provider,
    method: boundAccount.profile!.method as Parameters<
      typeof assertPayoutProviderCompatibility
    >[0]["method"],
    payoutCurrency: boundAccount.profile!.payoutCurrency,
    providerAccountRef: boundAccount.profile!.providerAccountRef,
  });
  return {
    payoutId,
    amount: quote.payoutAmount,
    currency: quote.payoutCurrency,
    quoteId: quote.id,
  };
}
