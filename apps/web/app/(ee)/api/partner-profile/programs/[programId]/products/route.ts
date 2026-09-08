import { getProgramEnrollmentOrThrow } from "@/lib/api/programs/get-program-enrollment-or-throw";
import { withPartnerProfile } from "@/lib/auth/partner";
import { prisma } from "@/lib/prisma";
import {
  resolveProductCustomerDiscount,
  selectCommissionRule,
  serializeGroupRewardCommission,
} from "@/lib/weletic/commissions/rules";
import { weleticCatalogQuerySchema } from "@/lib/zod/schemas/weletic-commerce";
import { NextResponse } from "next/server";

export const GET = withPartnerProfile(
  async ({ partner, params, searchParams }) => {
    const { q, marketId, countryCode, locale, page, pageSize } =
      weleticCatalogQuerySchema.parse(searchParams);
    const enrollment = await getProgramEnrollmentOrThrow({
      partnerId: partner.id,
      programId: params.programId,
      include: {
        program: true,
        links: {
          where: { disabledAt: null },
          include: {
            discountCode: true,
          },
        },
        partnerGroup: {
          include: {
            saleReward: true,
            discount: true,
          },
        },
      },
    });
    const now = new Date();
    const where = {
      programId: enrollment.programId,
      status: "active" as const,
      availableForSale: true,
      variants: {
        some: {
          availableForSale: true,
        },
      },
      ...(q && {
        OR: [
          { title: { contains: q } },
          { handle: { contains: q } },
          { vendor: { contains: q } },
          { productType: { contains: q } },
        ],
      }),
    };

    const [products, total, markets, rules] = await Promise.all([
      prisma.weleticShopifyProduct.findMany({
        where,
        include: {
          translations: {
            where: {
              locale,
              OR: [{ marketId: null }, ...(marketId ? [{ marketId }] : [])],
            },
          },
          variants: {
            where: {
              availableForSale: true,
            },
            include: {
              marketPrices: {
                where: {
                  ...(marketId && { marketId }),
                  ...(countryCode && { countryCode }),
                  available: true,
                },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.weleticShopifyProduct.count({ where }),
      prisma.weleticShopifyMarket.findMany({
        where: {
          store: { programId: enrollment.programId },
          enabled: true,
        },
        orderBy: [{ primary: "desc" }, { name: "asc" }],
      }),
      prisma.weleticCommissionRule.findMany({
        where: {
          programId: enrollment.programId,
          active: true,
          effectiveAt: { lte: now },
          NOT: [
            { logicalKey: { startsWith: "shopify-config:" } },
            { logicalKey: { startsWith: "dub-sale-reward:" } },
          ],
          AND: [
            { OR: [{ partnerId: null }, { partnerId: partner.id }] },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          ],
        },
      }),
    ]);

    return NextResponse.json({
      products: products.map((product) => {
        const translation =
          product.translations.find((item) => item.marketId === marketId) ??
          product.translations.find((item) => item.marketId === null);
        const collectionExternalIds = Array.isArray(
          product.collectionExternalIds,
        )
          ? product.collectionExternalIds.filter(
              (id): id is string => typeof id === "string",
            )
          : [];
        const firstVariant = product.variants[0];
        const rule = selectCommissionRule(rules, {
          programId: enrollment.programId,
          partnerId: partner.id,
          productId: product.id,
          variantId: firstVariant?.id,
          collectionExternalIds,
          accountingCurrency: enrollment.program.accountingCurrency,
          commissionableAmount: firstVariant?.shopPrice ?? BigInt(0),
          skipOrderThreshold: true,
          quantity: 1,
          occurredAt: now,
        });
        const partnerDiscountCode =
          enrollment.links?.find((l) => l.discountCode?.code)?.discountCode
            ?.code ?? null;
        const customerDiscount = resolveProductCustomerDiscount({
          discount: enrollment.partnerGroup?.discount,
          partnerCode: partnerDiscountCode,
          currency: enrollment.program.accountingCurrency,
          productContext: {
            productId: product.id,
            productExternalId: product.externalId,
            collectionExternalIds:
              (product.collectionExternalIds as string[]) ?? [],
          },
        });

        return {
          id: product.id,
          externalId: product.externalId,
          handle: product.handle,
          title: translation?.title ?? product.title,
          descriptionHtml:
            translation?.descriptionHtml ?? product.descriptionHtml,
          imageUrl: product.featuredImageUrl,
          vendor: product.vendor,
          productType: product.productType,
          variants: product.variants.map((variant) => {
            const marketPrice = variant.marketPrices?.[0];
            return {
              id: variant.id,
              title: variant.title,
              sku: variant.sku,
              imageUrl: variant.imageUrl,
              amount: (marketPrice?.amount ?? variant.shopPrice).toString(),
              compareAtAmount: (
                marketPrice?.compareAtAmount ?? variant.shopCompareAtPrice
              )?.toString(),
              currency: marketPrice?.currency ?? variant.shopCurrency,
            };
          }),
          commission: rule
            ? {
                ruleId: rule.id,
                source: rule.scope === "product" ? "product" : rule.scope,
                type: rule.ruleType,
                basisPoints: rule.basisPoints,
                fixedAmount: rule.fixedAmount?.toString() ?? null,
                currency: rule.currency,
                minOrderAmount: rule.minOrderAmount?.toString() ?? null,
              }
            : enrollment.partnerGroup?.saleReward
              ? serializeGroupRewardCommission({
                  reward: enrollment.partnerGroup.saleReward,
                  currency: enrollment.program.accountingCurrency,
                  productContext: {
                    productId: product.id,
                    productExternalId: product.externalId,
                    variantId: firstVariant?.id,
                    variantExternalId: firstVariant?.externalId,
                    collectionExternalIds:
                      (product.collectionExternalIds as string[]) ?? [],
                    tags: (product.tags as string[]) ?? [],
                    vendor: product.vendor,
                    productType: product.productType,
                  },
                })
              : null,
          customerDiscount,
        };
      }),
      markets: markets.map((market) => ({
        id: market.id,
        name: market.name,
        handle: market.handle,
        countryCodes: market.countryCodes,
        currencyCodes: market.currencyCodes,
        primary: market.primary,
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
      locale,
      countryCode: countryCode ?? null,
      accountingCurrency: enrollment.program.accountingCurrency,
    });
  },
);
