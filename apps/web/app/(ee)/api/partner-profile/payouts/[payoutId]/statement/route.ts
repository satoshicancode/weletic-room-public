import { withPartnerProfile } from "@/lib/auth/partner";
import { prisma } from "@/lib/prisma";
import { createWeleticPayoutQuote } from "@/lib/weletic/payouts/create-quote";
import { NextResponse } from "next/server";

export const GET = withPartnerProfile(async ({ partner, params }) => {
  const payout = await prisma.payout.findFirst({
    where: { id: params.payoutId, partnerId: partner.id },
    select: { id: true, status: true },
  });
  if (!payout)
    return NextResponse.json({ error: "Payout not found." }, { status: 404 });

  let statement = await prisma.weleticPayoutStatement.findUnique({
    where: { payoutId: payout.id },
  });
  if (
    !statement ||
    ["pending", "processing", "processed"].includes(payout.status)
  ) {
    await createWeleticPayoutQuote({ payoutId: payout.id });
    statement = await prisma.weleticPayoutStatement.findUniqueOrThrow({
      where: { payoutId: payout.id },
    });
  }
  return NextResponse.json(statement);
});
