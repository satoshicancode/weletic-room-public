import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

export const GET = withWorkspace(async ({ workspace, searchParams }) => {
  const { q } = z
    .object({
      q: z.string().optional(),
    })
    .parse(searchParams);

  const query = q?.trim();
  const programId = getDefaultProgramIdOrThrow(workspace);

  const where: Prisma.WeleticShopifyProductWhereInput = {
    programId,
    status: "active",
    ...(query
      ? {
          OR: [
            { title: { contains: query } },
            { handle: { contains: query } },
            {
              variants: {
                some: {
                  OR: [
                    { sku: { contains: query } },
                    { title: { contains: query } },
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };

  const products = await prisma.weleticShopifyProduct.findMany({
    where,
    select: {
      id: true,
      externalId: true,
      title: true,
      handle: true,
      tags: true,
      collectionExternalIds: true,
      variants: {
        select: {
          id: true,
          externalId: true,
          title: true,
          sku: true,
          shopPrice: true,
          shopCurrency: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { title: "asc" },
    take: 1000,
  });

  return NextResponse.json(
    products.map((product) => ({
      ...product,
      collectionExternalIds: Array.isArray(product.collectionExternalIds)
        ? product.collectionExternalIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      variants: product.variants.map((variant) => ({
        ...variant,
        shopPrice: variant.shopPrice.toString(),
      })),
    })),
  );
});
