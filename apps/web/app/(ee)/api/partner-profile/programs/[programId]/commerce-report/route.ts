import { getProgramEnrollmentOrThrow } from "@/lib/api/programs/get-program-enrollment-or-throw";
import { withPartnerProfile } from "@/lib/auth/partner";
import { prisma } from "@/lib/prisma";
import { resolveWeleticLocale } from "@/lib/weletic/localization";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

const querySchema = z.object({
  start: z.coerce.date().optional(),
  end: z.coerce.date().optional(),
  locale: z.string().optional(),
});

export const GET = withPartnerProfile(
  async ({ partner, params, searchParams }) => {
    const { start, end, locale } = querySchema.parse(searchParams);
    const enrollment = await getProgramEnrollmentOrThrow({
      partnerId: partner.id,
      programId: params.programId,
      include: { program: true },
    });
    const occurredAt = {
      ...(start && { gte: start }),
      ...(end && { lte: end }),
    };
    const orderWhere = {
      programId: enrollment.programId,
      partnerId: partner.id,
      ...(start || end ? { occurredAt } : {}),
    };
    const refundWhere = {
      order: { programId: enrollment.programId, partnerId: partner.id },
      ...(start || end ? { occurredAt } : {}),
    };

    const [orders, refunds, sales, reversals, presentment] = await Promise.all([
      prisma.weleticCommerceOrder.aggregate({
        where: orderWhere,
        _count: { id: true },
        _sum: { accountingNet: true, accountingTotal: true },
      }),
      prisma.weleticCommerceRefund.aggregate({
        where: refundWhere,
        _count: { id: true },
        _sum: { accountingAmount: true },
      }),
      prisma.weleticCommissionCalculation.aggregate({
        where: {
          entryType: "sale",
          orderLine: {
            order: {
              programId: enrollment.programId,
              partnerId: partner.id,
              ...(start || end ? { occurredAt } : {}),
            },
          },
        },
        _sum: { earnings: true },
      }),
      prisma.weleticCommissionCalculation.aggregate({
        where: {
          entryType: "reversal",
          refundLine: {
            refund: {
              order: { programId: enrollment.programId, partnerId: partner.id },
              ...(start || end ? { occurredAt } : {}),
            },
          },
        },
        _sum: { earnings: true },
      }),
      prisma.weleticCommerceOrder.groupBy({
        by: ["presentmentCurrency"],
        where: orderWhere,
        _count: { id: true },
        _sum: { presentmentNet: true },
      }),
    ]);

    return NextResponse.json({
      locale: resolveWeleticLocale(locale ?? partner.preferredLocale),
      accountingCurrency: enrollment.program.accountingCurrency,
      totals: {
        orders: orders._count.id,
        refunds: refunds._count.id,
        attributedRevenue: (orders._sum.accountingNet ?? BigInt(0)).toString(),
        grossOrderTotal: (orders._sum.accountingTotal ?? BigInt(0)).toString(),
        refundedRevenue: (
          refunds._sum.accountingAmount ?? BigInt(0)
        ).toString(),
        commissionEarnings: (
          (sales._sum.earnings ?? BigInt(0)) +
          (reversals._sum.earnings ?? BigInt(0))
        ).toString(),
      },
      presentmentCurrencies: presentment.map((group) => ({
        currency: group.presentmentCurrency,
        orders: group._count.id,
        revenue: (group._sum.presentmentNet ?? BigInt(0)).toString(),
      })),
    });
  },
);
