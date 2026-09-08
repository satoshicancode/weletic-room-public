import { getGroupOrThrow } from "@/lib/api/groups/get-group-or-throw";
import { getBountiesForPartner } from "@/lib/bounty/api/get-bounties-for-partner";
import { prisma } from "@/lib/prisma";
import { toCentsNumber } from "@dub/utils";

export async function getPartnerForProgram({
  partnerId,
  programId,
  includeComposite = false,
}: {
  partnerId: string;
  programId: string;
  includeComposite?: boolean;
}) {
  const data = await prisma.programEnrollment.findUnique({
    where: {
      partnerId_programId: {
        partnerId,
        programId,
      },
    },
    include: {
      partner: {
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          image: true,
          description: true,
          country: true,
          preferredLocale: true,
          timeZone: true,
          preferredDisplayCurrency: true,
          preferredPayoutCurrency: true,
          companyName: true,
          profileType: true,
          networkStatus: true,
          defaultPayoutMethod: true,
          paypalEmail: true,
          stripeConnectId: true,
          stripeRecipientId: true,
          payoutsEnabledAt: true,
          identityVerifiedAt: true,
          createdAt: true,
          updatedAt: true,
          monthlyTraffic: true,
          industryInterests: {
            select: {
              industryInterest: true,
            },
          },
          preferredEarningStructures: {
            select: {
              preferredEarningStructure: true,
            },
          },
          salesChannels: {
            select: {
              salesChannel: true,
            },
          },
          programPartnerTags: {
            where: {
              programId,
            },
            include: {
              partnerTag: true,
            },
          },
          platforms: true,
        },
      },
      links: {
        select: {
          id: true,
          domain: true,
          key: true,
          url: true,
          shortLink: true,
          clicks: true,
          leads: true,
          conversions: true,
          sales: true,
          saleAmount: true,
          createdAt: true,
          updatedAt: true,
          partnerGroupDefaultLinkId: true,
          lastLeadAt: true,
          lastConversionAt: true,
          comments: true,
        },
      },
      discount: {
        select: {
          id: true,
          provider: true,
        },
      },
      applicationEvent: {
        select: {
          referralSource: true,
          referredByPartnerId: true,
        },
      },
      ...(includeComposite
        ? {
            discountCodes: {
              select: {
                id: true,
                code: true,
                discountId: true,
                partnerId: true,
                linkId: true,
                disabledAt: true,
              },
            },
            partnerGroup: {
              include: {
                clickReward: true,
                leadReward: true,
                saleReward: true,
                referralReward: true,
                discount: true,
                utmTemplate: true,
                partnerGroupDefaultLinks: true,
                program: true,
                workflow: true,
              },
            },
            program: {
              select: {
                id: true,
                defaultGroupId: true,
              },
            },
          }
        : {}),
    },
  });

  if (!data) {
    return null;
  }

  const {
    partner,
    links,
    applicationEvent,
    partnerGroup,
    discountCodes,
    program,
    ...programEnrollment
  } = data as any;

  let compositeFields = {};

  if (includeComposite && program) {
    const [
      fallbackGroup,
      referredByPartner,
      referralStats,
      eligibleBounties,
      commentsCount,
      fraudCount,
    ] = await Promise.all([
      !partnerGroup
        ? getGroupOrThrow({
            programId,
            groupId: program.defaultGroupId,
            includeExpandedFields: true,
            includeBounties: true,
          })
        : Promise.resolve(null),
      applicationEvent?.referredByPartnerId
        ? prisma.partner.findUnique({
            where: {
              id: applicationEvent.referredByPartnerId,
            },
            select: {
              id: true,
              name: true,
              image: true,
            },
          })
        : Promise.resolve(null),
      prisma.programEnrollment.aggregate({
        where: {
          programId,
          applicationEvent: {
            referredByPartnerId: partnerId,
          },
        },
        _sum: {
          totalConversions: true,
          totalSaleAmount: true,
        },
        _count: {
          _all: true,
        },
      }),
      getBountiesForPartner({
        groupId: programEnrollment.groupId,
        partnerId: partner.id,
        totalCommissions: programEnrollment.totalCommissions,
        createdAt: programEnrollment.createdAt,
        status: programEnrollment.status,
        links,
        program,
        programPartnerTags: partner.programPartnerTags,
      }),
      prisma.partnerComment.count({
        where: {
          programId,
          partnerId,
        },
      }),
      prisma.fraudEventGroup.count({
        where: {
          programId,
          partnerId,
        },
      }),
    ]);

    const resolvedGroup = partnerGroup
      ? {
          ...partnerGroup,
          moveRules: partnerGroup.workflow?.triggerConditions ?? null,
        }
      : fallbackGroup;

    compositeFields = {
      group: resolvedGroup,
      discountCodes: discountCodes ?? [],
      referral: {
        referredBy: referredByPartner,
        stats: {
          totalPartners: referralStats._count._all,
          totalConversions: toCentsNumber(referralStats._sum.totalConversions),
          totalSaleAmount: toCentsNumber(referralStats._sum.totalSaleAmount),
        },
      },
      eligibleBounties: eligibleBounties ?? [],
      commentsCount: commentsCount ?? 0,
      fraudCount: fraudCount ?? 0,
    };
  }

  return {
    ...partner,
    ...programEnrollment,
    applicationEvent,
    netRevenue:
      toCentsNumber(programEnrollment.totalSaleAmount ?? 0) -
      toCentsNumber(programEnrollment.totalCommissions ?? 0),
    id: partner.id,
    createdAt: new Date(programEnrollment.createdAt),
    tags: partner.programPartnerTags
      .map(({ partnerTag }: any) => partnerTag)
      .filter((t: any) => t.programId != null && t.programId === programId),
    links,
    lastLeadAt: links.reduce((acc: any, link: any) => {
      return link.lastLeadAt && link.lastLeadAt > (acc ?? new Date(0))
        ? link.lastLeadAt
        : acc;
    }, undefined),
    lastConversionAt: links.reduce((acc: any, link: any) => {
      return link.lastConversionAt &&
        link.lastConversionAt > (acc ?? new Date(0))
        ? link.lastConversionAt
        : acc;
    }, undefined),
    industryInterests: partner.industryInterests.map(
      ({ industryInterest }: any) => industryInterest,
    ),
    preferredEarningStructures: partner.preferredEarningStructures.map(
      ({ preferredEarningStructure }: any) => preferredEarningStructure,
    ),
    salesChannels: partner.salesChannels.map(
      ({ salesChannel }: any) => salesChannel,
    ),
    ...compositeFields,
  };
}
