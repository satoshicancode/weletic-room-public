import { prisma } from "@/lib/prisma";
import { getAccountingFxQuote, persistFxQuote } from "@/lib/weletic/fx";
import { createWeleticId } from "@/lib/weletic/ids";
import { resolveWeleticLocale } from "@/lib/weletic/localization";
import { convertMoney, normalizeCurrency } from "@/lib/weletic/money";

export async function createWeleticPayoutQuote({
  payoutId,
  payoutProvider,
}: {
  payoutId: string;
  payoutProvider?: string;
}) {
  const payout = await prisma.payout.findUniqueOrThrow({
    where: { id: payoutId },
    include: {
      program: { select: { accountingCurrency: true, name: true } },
      partner: {
        select: {
          preferredLocale: true,
          preferredPayoutCurrency: true,
          weleticPayoutProfiles: {
            where: { status: "verified" },
            orderBy: { updatedAt: "desc" },
          },
        },
      },
      commissions: {
        select: {
          id: true,
          description: true,
          earnings: true,
          currency: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  const preferredPayoutCurrency = payout.partner.preferredPayoutCurrency
    ? normalizeCurrency(payout.partner.preferredPayoutCurrency)
    : null;
  const eligibleProfiles = payout.partner.weleticPayoutProfiles.filter(
    ({ programId, provider }) =>
      programId === payout.programId &&
      (!payoutProvider || provider === payoutProvider),
  );
  const profile =
    eligibleProfiles.find(
      ({ payoutCurrency, programId }) =>
        programId === payout.programId &&
        preferredPayoutCurrency &&
        normalizeCurrency(payoutCurrency) === preferredPayoutCurrency,
    ) ?? eligibleProfiles[0];
  const accountingCurrency = normalizeCurrency(
    payout.program.accountingCurrency,
  );
  const payoutCurrency = normalizeCurrency(
    profile?.payoutCurrency ?? accountingCurrency,
  );
  const fx = await getAccountingFxQuote({
    base: accountingCurrency,
    quote: payoutCurrency,
  });
  const snapshot = await persistFxQuote(fx);
  const converted = convertMoney(
    { amount: BigInt(payout.amount), currency: accountingCurrency },
    fx,
  );
  const quotedAt = new Date();
  const provider = profile?.provider ?? "accounting_currency";
  const quote = await prisma.weleticPayoutQuote.upsert({
    where: { payoutId },
    create: {
      id: createWeleticId("wquote_"),
      payoutId,
      payoutProfileId: profile?.id,
      accountingAmount: BigInt(payout.amount),
      accountingCurrency,
      payoutAmount: converted.amount,
      payoutCurrency,
      fxRate: fx.rate,
      feeAmount: BigInt(0),
      provider,
      fxRateSnapshotId: snapshot.id,
      quotedAt,
      expiresAt: new Date(quotedAt.getTime() + 15 * 60 * 1000),
    },
    update: {
      payoutProfileId: profile?.id,
      accountingAmount: BigInt(payout.amount),
      accountingCurrency,
      payoutAmount: converted.amount,
      payoutCurrency,
      fxRate: fx.rate,
      feeAmount: BigInt(0),
      provider,
      fxRateSnapshotId: snapshot.id,
      quotedAt,
      expiresAt: new Date(quotedAt.getTime() + 15 * 60 * 1000),
    },
  });

  const locale = resolveWeleticLocale(
    profile?.locale ?? payout.partner.preferredLocale,
  );
  await prisma.weleticPayoutStatement.upsert({
    where: { payoutId },
    create: {
      id: createWeleticId("wstatement_"),
      payoutId,
      locale,
      accountingCurrency,
      payoutCurrency,
      generatedAt: quotedAt,
      snapshot: {
        programName: payout.program.name,
        periodStart: payout.periodStart?.toISOString() ?? null,
        periodEnd: payout.periodEnd?.toISOString() ?? null,
        accountingAmount: payout.amount.toString(),
        accountingCurrency,
        payoutAmount: converted.amount.toString(),
        payoutCurrency,
        fxRate: fx.rate,
        feeAmount: "0",
        commissions: payout.commissions.map((commission) => ({
          id: commission.id,
          description: commission.description,
          earnings: commission.earnings.toString(),
          currency: commission.currency,
          createdAt: commission.createdAt.toISOString(),
        })),
      },
    },
    update: {
      locale,
      accountingCurrency,
      payoutCurrency,
      generatedAt: quotedAt,
      snapshot: {
        programName: payout.program.name,
        periodStart: payout.periodStart?.toISOString() ?? null,
        periodEnd: payout.periodEnd?.toISOString() ?? null,
        accountingAmount: payout.amount.toString(),
        accountingCurrency,
        payoutAmount: converted.amount.toString(),
        payoutCurrency,
        fxRate: fx.rate,
        feeAmount: "0",
        commissions: payout.commissions.map((commission) => ({
          id: commission.id,
          description: commission.description,
          earnings: commission.earnings.toString(),
          currency: commission.currency,
          createdAt: commission.createdAt.toISOString(),
        })),
      },
    },
  });
  return quote;
}

export async function refreshWeleticOpenPayoutQuotes({
  partnerId,
  programId,
  payoutProvider,
}: {
  partnerId: string;
  programId: string;
  payoutProvider?: string;
}) {
  const payouts = await prisma.payout.findMany({
    where: {
      partnerId,
      programId,
      status: { in: ["pending", "processing", "processed"] },
    },
    select: { id: true },
  });
  return Promise.allSettled(
    payouts.map(({ id }) =>
      createWeleticPayoutQuote({ payoutId: id, payoutProvider }),
    ),
  );
}
