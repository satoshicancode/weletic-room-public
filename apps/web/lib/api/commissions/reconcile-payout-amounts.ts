import { MUTABLE_PAYOUT_STATUSES } from "@/lib/constants/payouts";
import { prisma } from "@/lib/prisma";
import { chunk } from "@dub/utils";

export async function reconcilePayoutAmounts(payoutIds: string[]) {
  const uniquePayoutIds = [...new Set(payoutIds)];

  if (uniquePayoutIds.length === 0) {
    return;
  }

  const payoutIdChunks = chunk(uniquePayoutIds, 10);
  for (const payoutIdChunk of payoutIdChunks) {
    await prisma.$transaction(async (tx) => {
      const aggregates = await tx.commission.groupBy({
        by: ["payoutId"],
        where: {
          payoutId: {
            in: payoutIdChunk,
          },
        },
        _sum: {
          earnings: true,
        },
      });

      const sumByPayoutId = new Map(
        aggregates.map((a) => [a.payoutId!, Number(a._sum.earnings ?? 0)]),
      );

      const toDelete: string[] = [];
      const toUpdate: { id: string; amount: number }[] = [];

      for (const id of payoutIdChunk) {
        const newPayoutAmount = sumByPayoutId.get(id) ?? 0;

        if (newPayoutAmount <= 0) {
          toDelete.push(id);
        } else {
          toUpdate.push({ id, amount: newPayoutAmount });
        }
      }

      if (toDelete.length > 0) {
        // Unassign affected commissions back to rollover pool so negative balance
        // is preserved and will roll over to deduct from future earnings
        await tx.commission.updateMany({
          where: {
            payoutId: {
              in: toDelete,
            },
          },
          data: {
            payoutId: null,
            status: "pending",
          },
        });

        await tx.payout.deleteMany({
          where: {
            id: {
              in: toDelete,
            },
            status: {
              in: MUTABLE_PAYOUT_STATUSES,
            },
          },
        });
      }

      await Promise.all(
        toUpdate.map(({ id, amount }) =>
          tx.payout.update({
            where: {
              id,
              status: {
                in: MUTABLE_PAYOUT_STATUSES,
              },
            },
            data: {
              amount,
            },
          }),
        ),
      );

      for (const id of toDelete) {
        console.log(
          `[reconcilePayoutAmount] Deleted payout ${id} because it has non-positive amount or no commissions.`,
        );
      }

      for (const { id, amount } of toUpdate) {
        console.log(
          `[reconcilePayoutAmount] Updated payout amount for payout ${id} to ${amount}`,
        );
      }
    });
  }
}
