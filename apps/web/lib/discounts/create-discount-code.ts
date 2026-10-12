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

export const DISCOUNT_CODE_OWNED_BY_OTHER_PARTNER_MESSAGE = (code: string) =>
  `The discount code "${code}" was previously used by another partner and can't be reassigned. Please choose a different code.`;

const MAX_AUTO_CODE_SUFFIX_ATTEMPTS = 50;

// A code as typed and uppercased (providers store codes uppercased).
function codeVariants(code: string) {
  return Array.from(new Set([code, code.toUpperCase()]));
}

// Finds a code that is not taken (active or disabled) in the program, by
// appending a numeric suffix to the base code.
async function findFreeSuffixedCode(programId: string, baseCode: string) {
  for (let n = 2; n < 2 + MAX_AUTO_CODE_SUFFIX_ATTEMPTS; n++) {
    const candidate = `${baseCode}${n}`;
    let taken = null;
    for (const variant of codeVariants(candidate)) {
      taken = await prisma.discountCode.findFirst({
        where: { programId, code: variant },
        select: { id: true },
      });
      if (taken) break;
    }
    if (!taken) return candidate;
  }

  throw new DubApiError({
    code: "conflict",
    message:
      "Unable to generate a unique discount code for this partner. Please specify a custom code.",
  });
}

export async function createDiscountCode({
  workspace,
  partner,
  link,
  discount,
  code,
}: CreateDiscountCodeArgs) {
  let finalCode =
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

  // Check if a disabled code with (programId, finalCode) exists to auto-reactivate.
  // Providers store codes uppercased, so also match the uppercased code.
  let existingDisabledCode = null as Awaited<
    ReturnType<typeof prisma.discountCode.findFirst>
  >;
  for (const candidate of codeVariants(finalCode)) {
    existingDisabledCode = await prisma.discountCode.findFirst({
      where: {
        programId: discount.programId,
        code: candidate,
        disabledAt: { not: null },
      },
    });
    if (existingDisabledCode) break;
  }

  // A disabled code always keeps its original partner (attribution and
  // commission history must not move). Only the same partner may reactivate it.
  if (existingDisabledCode && existingDisabledCode.partnerId !== partner.id) {
    if (code) {
      throw new DubApiError({
        code: "conflict",
        message: DISCOUNT_CODE_OWNED_BY_OTHER_PARTNER_MESSAGE(finalCode),
      });
    }

    // Auto-generated code collided with another partner's disabled code:
    // fall back to a fresh, suffixed code for this partner.
    finalCode = await findFreeSuffixedCode(discount.programId, finalCode);
    existingDisabledCode = null;
  }

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
