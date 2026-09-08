import { enqueueBatchJobs } from "@/lib/cron/enqueue-batch-jobs";
import { queueBatchEmail } from "@/lib/email/queue-batch-email";
import { createPayPalBatchPayout } from "@/lib/paypal/create-batch-payout";
import { prisma } from "@/lib/prisma";
import PartnerPayoutProcessed from "@dub/email/templates/partner-payout-processed";
import { APP_DOMAIN_WITH_NGROK, currencyFormatter } from "@dub/utils";
import { Invoice } from "@prisma/client";
import { waitUntil } from "@vercel/functions";

export async function sendPaypalPayouts({
  invoice,
}: {
  invoice: Pick<Invoice, "id" | "payoutMode">;
}) {
  if (invoice.payoutMode === "external") {
    console.log(
      `Invoice ${invoice.id} is paid externally, skipping PayPal payouts...`,
    );
    return;
  }

  const payouts = await prisma.payout.findMany({
    where: {
      invoiceId: invoice.id,
      status: "processing",
      mode: "internal",
      method: "paypal",
      partner: {
        payoutsEnabledAt: {
          not: null,
        },
        paypalEmail: {
          not: null,
        },
      },
    },
    include: {
      partner: {
        select: {
          email: true,
          paypalEmail: true,
        },
      },
      program: {
        select: {
          name: true,
          logo: true,
        },
      },
    },
  });

  if (payouts.length === 0) {
    console.log("No payouts for sending via PayPal, skipping...");
    return;
  }

  const batchResult = await createPayPalBatchPayout({
    payouts,
    invoiceId: invoice.id,
  });

  console.log("PayPal batch payout results", batchResult);

  // Update only successfully accepted payouts to "sent" status
  if (batchResult.successfulPayoutIds.length > 0) {
    const successfulPayouts = payouts.filter((p) =>
      batchResult.successfulPayoutIds.includes(p.id),
    );

    await prisma.payout.updateMany({
      where: {
        id: { in: batchResult.successfulPayoutIds },
      },
      data: {
        status: "sent",
        paidAt: new Date(),
        method: "paypal",
      },
    });

    console.log(
      `Updated ${batchResult.successfulPayoutIds.length} payouts to "sent" status`,
    );

    waitUntil(
      Promise.allSettled([
        queueBatchEmail<typeof PartnerPayoutProcessed>(
          successfulPayouts.map((payout) => ({
            variant: "notifications",
            to: payout.partner.email!,
            subject: `You've received a ${currencyFormatter(payout.amount)} payout from ${payout.program.name}`,
            templateName: "PartnerPayoutProcessed",
            templateProps: {
              email: payout.partner.email!,
              program: payout.program,
              payout,
            },
          })),
        ),

        enqueueBatchJobs(
          successfulPayouts.map((payout) => ({
            queueName: "create-referral-commissions",
            url: `${APP_DOMAIN_WITH_NGROK}/api/cron/commissions/referrals/queue`,
            body: {
              payoutId: payout.id,
            },
          })),
        ),
      ]),
    );
  }

  // Handle any failed batches
  if (batchResult.failedPayoutIds.length > 0) {
    const failedErrors = batchResult.results
      .filter((r) => !r.success)
      .map((r) => `[${r.currency}] ${r.error}`)
      .join("; ");

    console.error(
      `[sendPaypalPayouts] Some PayPal currency batches failed: ${failedErrors}`,
    );

    await prisma.payout.updateMany({
      where: {
        id: { in: batchResult.failedPayoutIds },
      },
      data: {
        status: "failed",
      },
    });

    throw new Error(
      `PayPal batch dispatch had partial failures: ${failedErrors}`,
    );
  }
}
