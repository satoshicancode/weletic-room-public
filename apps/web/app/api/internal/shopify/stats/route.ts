import { prisma } from "@/lib/prisma";
import { verifyWeleticShopifyRequest } from "@/lib/weletic/shopify/service-auth";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import { APP_DOMAIN, PARTNERS_DOMAIN, currencyFormatter } from "@dub/utils";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

export const dynamic = "force-dynamic";

const shopSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/);

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  if (!verifyWeleticShopifyRequest({ request, body: "" })) {
    return unauthorized();
  }

  const parsedShop = shopSchema.safeParse(
    new URL(request.url).searchParams.get("shop"),
  );
  if (!parsedShop.success) {
    return NextResponse.json({ error: "Invalid shop" }, { status: 400 });
  }

  try {
    const resolution = await resolveShopifyStoreByDomain(parsedShop.data);
    const workspace = resolution
      ? await prisma.project.findUnique({
          where: { id: resolution.workspaceId },
          select: {
            id: true,
            slug: true,
            name: true,
            defaultProgramId: true,
          },
        })
      : null;

    const defaultProgram = workspace?.defaultProgramId
      ? await prisma.program.findUnique({
          where: { id: workspace.defaultProgramId },
          select: { id: true, accountingCurrency: true },
        })
      : null;

    if (!workspace || !defaultProgram) {
      return NextResponse.json({
        isConnected: false,
        connectUrl: APP_DOMAIN,
        workspaceSlug: null,
        workspaceName: null,
        dashboardUrl: null,
        partnerCatalogUrl: null,
        kpis: {
          revenue: currencyFormatter(0),
          orders: 0,
          affiliates: 0,
          commissions: currencyFormatter(0),
        },
        partnerLinks: [],
        topPartners: [],
      });
    }

    const { id: programId, accountingCurrency } = defaultProgram;
    const [aggregates, links, topEnrollments] = await Promise.all([
      prisma.programEnrollment.aggregate({
        where: { programId, status: "approved" },
        _count: { id: true },
        _sum: {
          totalSales: true,
          totalSaleAmount: true,
          totalCommissions: true,
        },
      }),
      prisma.link.findMany({
        where: { projectId: workspace.id, programId, archived: false },
        orderBy: { saleAmount: "desc" },
        take: 10,
        select: {
          id: true,
          shortLink: true,
          url: true,
          clicks: true,
          leads: true,
          saleAmount: true,
          partner: { select: { name: true } },
        },
      }),
      prisma.programEnrollment.findMany({
        where: { programId, status: "approved" },
        orderBy: { totalSaleAmount: "desc" },
        take: 5,
        select: {
          id: true,
          totalClicks: true,
          totalConversions: true,
          totalSaleAmount: true,
          partner: { select: { name: true } },
          partnerGroup: { select: { name: true } },
        },
      }),
    ]);

    return NextResponse.json({
      isConnected: true,
      connectUrl: APP_DOMAIN,
      workspaceSlug: workspace.slug,
      workspaceName: workspace.name,
      dashboardUrl: `${APP_DOMAIN}/${workspace.slug}/program`,
      partnerCatalogUrl: `${PARTNERS_DOMAIN}/programs/${workspace.slug}/products`,
      kpis: {
        revenue: currencyFormatter(
          aggregates._sum.totalSaleAmount ?? BigInt(0),
          { currency: accountingCurrency },
        ),
        orders: aggregates._sum.totalSales ?? 0,
        affiliates: aggregates._count.id,
        commissions: currencyFormatter(
          aggregates._sum.totalCommissions ?? BigInt(0),
          { currency: accountingCurrency },
        ),
      },
      partnerLinks: links.map((link) => ({
        id: link.id,
        url: link.shortLink,
        destination: link.url,
        partnerName: link.partner?.name ?? "Partner",
        clicks: link.clicks,
        leads: link.leads,
        sales: currencyFormatter(link.saleAmount, {
          currency: accountingCurrency,
        }),
      })),
      topPartners: topEnrollments.map((enrollment) => ({
        id: enrollment.id,
        name: enrollment.partner.name ?? "Partner",
        tier: enrollment.partnerGroup?.name ?? "Default",
        totalSales: currencyFormatter(enrollment.totalSaleAmount, {
          currency: accountingCurrency,
        }),
        conversionRate:
          enrollment.totalClicks > 0
            ? `${((enrollment.totalConversions / enrollment.totalClicks) * 100).toFixed(1)}%`
            : "0.0%",
      })),
    });
  } catch (error) {
    console.error("[Shopify internal stats error]", error);
    return NextResponse.json(
      { error: "Unable to load Shopify statistics" },
      { status: 500 },
    );
  }
}
