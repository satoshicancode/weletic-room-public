import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { createWeleticCommissionRuleSchema } from "@/lib/zod/schemas/weletic-commerce";
import { nanoid } from "@dub/utils";
import { NextResponse } from "next/server";

export const GET = withWorkspace(async ({ workspace }) => {
  const programId = getDefaultProgramIdOrThrow(workspace);
  const rules = await prisma.weleticCommissionRule.findMany({
    where: { programId },
    orderBy: [{ active: "desc" }, { priority: "desc" }, { createdAt: "desc" }],
  });
  return NextResponse.json(
    rules.map((rule) => ({
      ...rule,
      fixedAmount: rule.fixedAmount?.toString() ?? null,
      minOrderAmount: rule.minOrderAmount?.toString() ?? null,
      maxCommissionAmount: rule.maxCommissionAmount?.toString() ?? null,
    })),
  );
});

export const POST = withWorkspace(
  async ({ workspace, req, session }) => {
    const programId = getDefaultProgramIdOrThrow(workspace);
    const input = createWeleticCommissionRuleSchema.parse(
      await parseRequestBody(req),
    );
    const program = await prisma.program.findUniqueOrThrow({
      where: { id: programId },
      select: { accountingCurrency: true },
    });
    if (
      input.ruleType === "fixed" &&
      input.currency !== program.accountingCurrency
    ) {
      throw new Error(
        `Fixed commission currency must be ${program.accountingCurrency}.`,
      );
    }
    if (input.productId) {
      const product = await prisma.weleticShopifyProduct.findFirst({
        where: { id: input.productId, programId },
        select: { id: true },
      });
      if (!product) throw new Error("Product does not belong to this program.");
    }
    if (input.variantId) {
      const variant = await prisma.weleticShopifyVariant.findFirst({
        where: { id: input.variantId, product: { programId } },
        select: { id: true },
      });
      if (!variant) throw new Error("Variant does not belong to this program.");
    }
    if (input.partnerId) {
      const enrollment = await prisma.programEnrollment.findUnique({
        where: {
          partnerId_programId: { partnerId: input.partnerId, programId },
        },
        select: { id: true },
      });
      if (!enrollment)
        throw new Error("Partner is not enrolled in this program.");
    }

    const logicalKey = input.logicalKey ?? `rule_${nanoid(16)}`;
    const rule = await prisma.$transaction(async (tx) => {
      const latest = await tx.weleticCommissionRule.findFirst({
        where: { programId, logicalKey },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      await tx.weleticCommissionRule.updateMany({
        where: { programId, logicalKey, active: true },
        data: { active: false, expiresAt: input.effectiveAt },
      });
      return tx.weleticCommissionRule.create({
        data: {
          id: createWeleticId("wrule_"),
          programId,
          logicalKey,
          version: (latest?.version ?? 0) + 1,
          scope: input.scope,
          partnerId: input.partnerId,
          ruleType: input.ruleType,
          fixedAmountMode: input.fixedAmountMode,
          priority: input.priority,
          collectionExternalId: input.collectionExternalId,
          productId: input.productId,
          variantId: input.variantId,
          promotionCode: input.promotionCode,
          tag: input.tag,
          basisPoints:
            input.ruleType === "percentage" ? input.basisPoints : null,
          fixedAmount: input.ruleType === "fixed" ? input.fixedAmount : null,
          currency:
            input.ruleType === "fixed" ? program.accountingCurrency : null,
          minOrderAmount: input.minOrderAmount,
          maxCommissionAmount: input.maxCommissionAmount,
          effectiveAt: input.effectiveAt,
          expiresAt: input.expiresAt,
          createdByUserId: session.user.id,
        },
      });
    });

    return NextResponse.json(
      {
        ...rule,
        fixedAmount: rule.fixedAmount?.toString() ?? null,
        minOrderAmount: rule.minOrderAmount?.toString() ?? null,
        maxCommissionAmount: rule.maxCommissionAmount?.toString() ?? null,
      },
      { status: 201 },
    );
  },
  { requiredRoles: ["owner"] },
);
