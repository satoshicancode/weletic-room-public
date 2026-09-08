import { createId } from "@/lib/api/create-id";
import { DubApiError } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";
import { Discount, Link, Partner, Prisma, Project } from "@prisma/client";
import { constructDiscountCode } from "./construct-discount-code";
import { getDiscountProvider } from "./discount-provider";

interface CreateDiscountCodeArgs {
  workspace: Pick<Project, "id" | "stripeConnectId" | "shopifyStoreId">;
  partner: Pick<Partner, "id" | "name">;
  link: Pick<Link, "id">;
  discount: Discount;
  code?: string;
}

export async function createDiscountCode({
  workspace,
  partner,
  link,
  discount,
  code,
}: CreateDiscountCodeArgs) {
  const finalCode =
    code ||
    constructDiscountCode({
      partner,
      discount,
    });

  const activeCodeOnLink = await prisma.discountCode.findFirst({
    where: {
      linkId: link.id,
      disabledAt: null,
    },
    select: { code: true },
  });

  if (activeCodeOnLink) {
    throw new DubApiError({
      code: "bad_request",
      message: `This link already has a discount code (${activeCodeOnLink.code}) assigned.`,
    });
  }

  // Check if a disabled code with (programId, finalCode) exists to auto-reactivate
  const existingDisabledCode = await prisma.discountCode.findFirst({
    where: {
      programId: discount.programId,
      code: finalCode,
      disabledAt: { not: null },
    },
  });

  const discountProvider = getDiscountProvider(discount.provider);

  if (existingDisabledCode) {
    // Unlink any other disabled code currently occupying this link slot
    await prisma.discountCode.updateMany({
      where: {
        linkId: link.id,
        disabledAt: { not: null },
        id: { not: existingDisabledCode.id },
      },
      data: {
        linkId: null,
      },
    });

    // Re-create/sync the discount code with the provider
    await discountProvider.createDiscountCode({
      workspace,
      discount,
      code: finalCode,
      shouldRetry: code ? false : true,
    });

    // Reactivate the existing record in-place
    return await prisma.discountCode.update({
      where: {
        id: existingDisabledCode.id,
      },
      data: {
        disabledAt: null,
        partnerId: partner.id,
        linkId: link.id,
        discountId: discount.id,
        updatedAt: new Date(),
      },
    });
  }

  // Unlink any disabled code currently occupying this link slot so the new code can use link.id
  await prisma.discountCode.updateMany({
    where: {
      linkId: link.id,
      disabledAt: { not: null },
    },
    data: {
      linkId: null,
    },
  });

  const externalDiscountCode = await discountProvider.createDiscountCode({
    workspace,
    discount,
    code: finalCode,
    shouldRetry: code ? false : true,
  });

  try {
    return await prisma.discountCode.create({
      data: {
        id: createId({ prefix: "dcode_" }),
        code: externalDiscountCode.code,
        programId: discount.programId,
        partnerId: partner.id,
        linkId: link.id,
        discountId: discount.id,
      },
    });
  } catch (error) {
    try {
      await discountProvider.disableDiscountCode({
        workspace,
        code: externalDiscountCode.code,
      });
    } catch (rollbackError) {
      console.error("Failed to rollback external discount code", {
        code: externalDiscountCode.code,
        rollbackError,
      });
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new DubApiError({
        code: "conflict",
        message:
          "This discount code is already in use, or this link already has a code. Please refresh and try again.",
      });
    }

    throw error;
  }
}
