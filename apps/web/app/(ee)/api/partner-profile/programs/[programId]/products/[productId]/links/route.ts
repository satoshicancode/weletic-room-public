import { DubApiError, ErrorCodes } from "@/lib/api/errors";
import { createLink, deleteLink, processLink } from "@/lib/api/links";
import { getProgramEnrollmentOrThrow } from "@/lib/api/programs/get-program-enrollment-or-throw";
import { parseRequestBody } from "@/lib/api/utils";
import { withPartnerProfile } from "@/lib/auth/partner";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/upstash";
import { resolveProductCustomerDiscount } from "@/lib/weletic/commissions/rules";
import { createWeleticId } from "@/lib/weletic/ids";
import { buildWeleticProductTargetUrl } from "@/lib/weletic/shopify/product-url";
import { INACTIVE_ENROLLMENT_STATUSES } from "@/lib/zod/schemas/partners";
import { createWeleticProductLinkSchema } from "@/lib/zod/schemas/weletic-commerce";
import { NextResponse } from "next/server";

export const POST = withPartnerProfile(
  async ({ partner, params, req, session }) => {
    const input = createWeleticProductLinkSchema.parse(
      await parseRequestBody(req),
    );
    const linkCreationLock = `weletic:product-link:${params.programId}:${partner.id}`;
    const acquired = await redis.set(linkCreationLock, "1", {
      nx: true,
      ex: 60,
    });
    if (!acquired) {
      throw new DubApiError({
        code: "rate_limit_exceeded",
        message: "Another product link is being created. Please try again.",
      });
    }
    try {
      const enrollment = await getProgramEnrollmentOrThrow({
        partnerId: partner.id,
        programId: params.programId,
        include: {
          program: true,
          links: { select: { id: true } },
          discountCodes: {
            where: { disabledAt: null },
            take: 1,
          },
          partnerGroup: {
            include: {
              discount: true,
            },
          },
        },
      });
      if (INACTIVE_ENROLLMENT_STATUSES.includes(enrollment.status)) {
        throw new DubApiError({
          code: "forbidden",
          message: `You cannot create product links because the enrollment is ${enrollment.status}.`,
        });
      }
      if (!enrollment.partnerGroup) {
        throw new DubApiError({
          code: "forbidden",
          message: "A partner group is required before creating product links.",
        });
      }
      if (!enrollment.program.domain || !enrollment.program.url) {
        throw new DubApiError({
          code: "bad_request",
          message:
            "The program short domain and storefront URL must be configured.",
        });
      }

      const product = await prisma.weleticShopifyProduct.findFirst({
        where: {
          id: params.productId,
          programId: enrollment.programId,
          status: "active",
          availableForSale: true,
        },
        include: {
          store: true,
        },
      });
      if (!product) {
        throw new DubApiError({
          code: "not_found",
          message: "Product not found or unavailable.",
        });
      }
      const market = input.marketId
        ? await prisma.weleticShopifyMarket.findFirst({
            where: {
              id: input.marketId,
              storeId: product.storeId,
              enabled: true,
            },
          })
        : await prisma.weleticShopifyMarket.findFirst({
            where: { storeId: product.storeId, enabled: true },
            orderBy: [{ primary: "desc" }, { createdAt: "asc" }],
          });
      if (input.marketId && !market) {
        throw new DubApiError({
          code: "not_found",
          message: "Market not found for this Shopify store.",
        });
      }
      const countryCodes = Array.isArray(market?.countryCodes)
        ? market.countryCodes.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const countryCode = input.countryCode ?? countryCodes[0];
      if (market && !countryCode) {
        throw new DubApiError({
          code: "bad_request",
          message: "The selected Shopify market has no supported country.",
        });
      }
      if (input.countryCode && !countryCodes.includes(input.countryCode)) {
        throw new DubApiError({
          code: "bad_request",
          message: "Country is not part of the selected Shopify market.",
        });
      }
      const variant = await prisma.weleticShopifyVariant.findFirst({
        where: {
          productId: product.id,
          availableForSale: true,
          ...(input.variantId && { id: input.variantId }),
          ...(market && {
            marketPrices: {
              some: {
                marketId: market.id,
                ...(countryCode && { countryCode }),
                available: true,
              },
            },
          }),
        },
        orderBy: { createdAt: "asc" },
      });
      if (!variant) {
        throw new DubApiError({
          code: "not_found",
          message: "No purchasable variant is available in this market.",
        });
      }
      const rootUrls = Array.isArray(market?.rootUrls)
        ? market.rootUrls.filter(
            (value): value is { locale: string; url: string } =>
              Boolean(
                value &&
                  typeof value === "object" &&
                  "locale" in value &&
                  typeof value.locale === "string" &&
                  "url" in value &&
                  typeof value.url === "string",
              ),
          )
        : [];
      const localeRootUrl =
        rootUrls.find(({ locale }) => locale === input.locale)?.url ??
        rootUrls.find(({ locale }) =>
          locale.toLowerCase().startsWith(`${input.locale.toLowerCase()}-`),
        )?.url;

      const partnerDiscountCode = enrollment.discountCodes?.[0]?.code;
      const customerDiscount = resolveProductCustomerDiscount({
        discount: enrollment.partnerGroup?.discount,
        partnerCode: partnerDiscountCode,
        currency:
          (Array.isArray(market?.currencyCodes) &&
            typeof market.currencyCodes[0] === "string" &&
            market.currencyCodes[0]) ||
          "VND",
        productContext: {
          productId: product.id,
          productExternalId: product.externalId,
          collectionExternalIds: Array.isArray(product.collectionExternalIds)
            ? product.collectionExternalIds.filter(
                (c): c is string => typeof c === "string",
              )
            : [],
        },
      });
      const activeDiscountCode =
        customerDiscount?.couponCode ?? partnerDiscountCode ?? null;

      const targetUrl = buildWeleticProductTargetUrl({
        storefrontUrl:
          localeRootUrl ?? market?.webPresenceUrl ?? enrollment.program.url,
        handle: product.handle,
        variantExternalId: variant?.externalId,
        marketHandle: market?.handle,
        countryCode,
        locale: input.locale,
        discountCode: activeDiscountCode,
        subId: input.subId,
        subId1: input.subId1,
        subId2: input.subId2,
        subId3: input.subId3,
        subId4: input.subId4,
        subId5: input.subId5,
      });

      const { link, error, code } = await processLink({
        payload: {
          domain: enrollment.program.domain,
          key: input.key,
          url: targetUrl,
          programId: enrollment.programId,
          tenantId: enrollment.tenantId,
          partnerId: partner.id,
          folderId: enrollment.program.defaultFolderId,
          trackConversion: true,
          comments: `Weletic product: ${product.externalId}`,
        },
        workspace: {
          id: enrollment.program.workspaceId,
          plan: "business",
          users: [{ role: "owner" }],
        },
        userId: session.user.id,
        skipFolderChecks: true,
        skipProgramChecks: true,
        skipExternalIdChecks: true,
      });
      if (error !== null) {
        throw new DubApiError({
          code: code as ErrorCodes,
          message: error,
        });
      }

      const createdLink = await createLink(link);
      let productLink;
      try {
        productLink = await prisma.weleticProductLink.create({
          data: {
            id: createWeleticId("wplink_"),
            programId: enrollment.programId,
            partnerId: partner.id,
            productId: product.id,
            variantId: variant.id,
            marketId: market?.id,
            countryCode,
            linkId: createdLink.id,
            locale: input.locale,
            subId: input.subId,
            targetUrl,
          },
        });
      } catch (error) {
        await deleteLink(createdLink.id).catch(() => {});
        throw error;
      }

      return NextResponse.json(
        {
          id: productLink.id,
          linkId: createdLink.id,
          shortLink: createdLink.shortLink,
          targetUrl,
          productId: product.id,
          variantId: variant.id,
          marketId: market?.id ?? null,
          countryCode: countryCode ?? null,
          locale: input.locale,
          subId: input.subId ?? null,
        },
        { status: 201 },
      );
    } finally {
      await redis.del(linkCreationLock);
    }
  },
);
