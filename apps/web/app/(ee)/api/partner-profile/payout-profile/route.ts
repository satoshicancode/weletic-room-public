import { parseRequestBody } from "@/lib/api/utils";
import { withPartnerProfile } from "@/lib/auth/partner";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { refreshWeleticOpenPayoutQuotes } from "@/lib/weletic/payouts/create-quote";
import { weleticPayoutProfileSchema } from "@/lib/weletic/payouts/profile-schema";
import { assertPayoutProviderCompatibility } from "@/lib/weletic/payouts/providers";
import { NextResponse } from "next/server";

const serializePayoutProfile = <
  T extends {
    providerAccountRef: string | null;
    verifiedByUserId: string | null;
    verificationNotes: string | null;
  },
>({
  providerAccountRef,
  verifiedByUserId: _verifiedByUserId,
  verificationNotes: _verificationNotes,
  ...profile
}: T) => ({
  ...profile,
  providerAccountConfigured: Boolean(providerAccountRef),
});

export const GET = withPartnerProfile(async ({ partner }) => {
  const profiles = await prisma.weleticPayoutProfile.findMany({
    where: { partnerId: partner.id },
    orderBy: [{ status: "desc" }, { updatedAt: "desc" }],
  });
  return NextResponse.json(profiles.map(serializePayoutProfile));
});

export const PUT = withPartnerProfile(
  async ({ partner, req }) => {
    const input = weleticPayoutProfileSchema.parse(await parseRequestBody(req));
    await prisma.programEnrollment.findUniqueOrThrow({
      where: {
        partnerId_programId: {
          partnerId: partner.id,
          programId: input.programId,
        },
      },
      select: { id: true },
    });
    assertPayoutProviderCompatibility({
      ...input,
      requireConnectedAccount: false,
    });
    const providerAccountRef =
      input.provider === "stripe_connect"
        ? partner.stripeConnectId
        : input.provider === "paypal"
          ? partner.paypalEmail
          : null;
    const profile = await prisma.weleticPayoutProfile.upsert({
      where: {
        partnerId_programId_payoutCurrency_provider: {
          partnerId: partner.id,
          programId: input.programId,
          payoutCurrency: input.payoutCurrency,
          provider: input.provider,
        },
      },
      create: {
        id: createWeleticId("wprofile_"),
        partnerId: partner.id,
        programId: input.programId,
        country: input.country,
        payoutCurrency: input.payoutCurrency,
        provider: input.provider,
        method: input.method,
        providerAccountRef,
        taxResidencyCountry: input.taxResidencyCountry,
        locale: input.locale,
        details: input.details,
        status: "pending_verification",
      },
      update: {
        country: input.country,
        method: input.method,
        providerAccountRef,
        taxResidencyCountry: input.taxResidencyCountry,
        locale: input.locale,
        details: input.details,
        status: "pending_verification",
        verifiedAt: null,
        verifiedByUserId: null,
        verificationNotes: null,
      },
    });
    await prisma.partner.update({
      where: { id: partner.id },
      data: {
        preferredLocale: input.locale,
        preferredPayoutCurrency: input.payoutCurrency,
      },
    });
    await refreshWeleticOpenPayoutQuotes({
      partnerId: partner.id,
      programId: input.programId,
    });
    return NextResponse.json(serializePayoutProfile(profile));
  },
  { requiredPermission: "partner_profile.update" },
);
