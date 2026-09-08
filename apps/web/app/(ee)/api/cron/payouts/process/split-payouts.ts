import { createId } from "@/lib/api/create-id";
import { getPayoutEligibilityFilter } from "@/lib/api/payouts/payout-eligibility-filter";
import { payoutIdSelectionWhere } from "@/lib/api/payouts/payout-id-selection-where";
import {
  CUTOFF_PERIOD,
  CUTOFF_PERIOD_TYPES,
} from "@/lib/partners/cutoff-period";
import { prisma } from "@/lib/prisma";
import { createWeleticPayoutQuote } from "@/lib/weletic/payouts/create-quote";
import { Program } from "@prisma/client";
import { endOfMonth } from "date-fns";

export async function splitPayouts({
  program,
  cutoffPeriod,
  selectedPayoutIds,
  excludedPayoutIds,
}: {
  program: Pick<
    Program,
    "id" | "name" | "minPayoutAmount" | "payoutMode" | "accountingCurrency"
  >;
  cutoffPeriod: CUTOFF_PERIOD_TYPES;
  selectedPayoutIds?: string[];
  excludedPayoutIds?: string[];
}) {
  const payouts = await prisma.payout.findMany({
    where: {
      ...payoutIdSelectionWhere({ selectedPayoutIds, excludedPayoutIds }),
      ...getPayoutEligibilityFilter({ program }),
    },
    include: {
      commissions: true,
    },
  });

  if (payouts.length === 0) {
    return;
  }
  const payoutIdsToQuote = new Set<string>();

  const cutoffPeriodValue = CUTOFF_PERIOD.find(
    (c) => c.id === cutoffPeriod,
  )!.value;

  for (const payout of payouts) {
    const previousCommissions = payout.commissions
      .filter((commission) => {
        return commission.createdAt < cutoffPeriodValue;
      })
      .sort((a, b) => {
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    const currentCommissions = payout.commissions
      .filter((commission) => {
        return commission.createdAt >= cutoffPeriodValue;
      })
      .sort((a, b) => {
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    const previousCommissionsCount = previousCommissions.length;
    const currentCommissionsCount = currentCommissions.length;

    // If there are previous commissions, we need to split the payout into two
    // 1 - one for everything up until the end of the previous month
    // 2 - everything else in the current month will be left as pending (and excluded from the payout)
    if (previousCommissionsCount > 0) {
      await prisma.$transaction(async (tx) => {
        const previousAmount = previousCommissions.reduce(
          (total, commission) => total + commission.earnings,
          0,
        );

        await tx.payout.update({
          where: {
            id: payout.id,
          },
          data: {
            periodEnd: endOfMonth(
              previousCommissions[previousCommissionsCount - 1].createdAt,
            ),
            amount: previousAmount,
          },
        });

        // Invalidate quotes and statements for the modified payout
        await tx.weleticPayoutQuote.deleteMany({
          where: { payoutId: payout.id },
        });
        await tx.weleticPayoutStatement.deleteMany({
          where: { payoutId: payout.id },
        });

        payoutIdsToQuote.add(payout.id);

        if (currentCommissionsCount > 0) {
          const currentMonthPayout = await tx.payout.create({
            data: {
              id: createId({ prefix: "po_" }),
              programId: program.id,
              partnerId: payout.partnerId,
              periodStart: currentCommissions[0].createdAt,
              periodEnd:
                currentCommissions[currentCommissionsCount - 1].createdAt,
              amount: currentCommissions.reduce(
                (total, commission) => total + commission.earnings,
                0,
              ),
              currency: program.accountingCurrency,
              description: `Dub Partners payout (${program.name})`,
            },
          });
          payoutIdsToQuote.add(currentMonthPayout.id);

          await tx.commission.updateMany({
            where: {
              id: {
                in: currentCommissions.map((commission) => commission.id),
              },
            },
            data: {
              payoutId: currentMonthPayout.id,
            },
          });
        }
      });
    }
  }

  await Promise.allSettled(
    [...payoutIdsToQuote].map((payoutId) =>
      createWeleticPayoutQuote({ payoutId }),
    ),
  );
}
