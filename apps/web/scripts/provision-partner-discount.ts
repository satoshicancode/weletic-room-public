import { PrismaClient } from "@prisma/client";
import "dotenv-flow/config";

const prisma = new PrismaClient();

async function main() {
  const discount = await prisma.discount.findFirst({
    where: {
      program: { slug: "we" },
    },
    include: {
      partnerGroup: true,
    },
  });

  if (!discount) {
    console.log("No discount found for program 'we'");
    return;
  }

  const partners = await prisma.partner.findMany({
    include: {
      links: {
        where: {
          programId: discount.programId,
        },
      },
    },
  });

  for (const partner of partners) {
    const defaultLink = partner.links[0];
    if (!defaultLink) continue;

    const existingDiscountCode = await prisma.discountCode.findFirst({
      where: {
        partnerId: partner.id,
        programId: discount.programId,
      },
    });

    if (existingDiscountCode) {
      console.log(
        `Partner ${partner.name} already has discount code: ${existingDiscountCode.code}`,
      );
      continue;
    }

    // Code format: e.g. PARTNER4_10 or YAMAX10
    const codeName = (
      partner.name.toUpperCase().replace(/[^A-Z0-9]/g, "") +
      "_" +
      discount.amount
    ).slice(0, 20);

    // Call Shopify GraphQL Dev Proxy
    const query = /* GraphQL */ `
      mutation DiscountCodeBasicCreate(
        $basicCodeDiscount: DiscountCodeBasicInput!
      ) {
        discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
          codeDiscountNode {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                codes(first: 1) {
                  nodes {
                    code
                  }
                }
              }
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    const variables = {
      basicCodeDiscount: {
        title: `Weletic Partner (${codeName})`,
        code: codeName,
        startsAt: new Date().toISOString(),
        customerSelection: { all: true },
        appliesOncePerCustomer: true,
        customerGets: {
          items: { all: true },
          appliesOnOneTimePurchase: true,
          value: {
            percentage: discount.amount / 100,
          },
        },
      },
    };

    try {
      const resp = await fetch(
        "http://localhost:3457/graphiql/graphql.json?key=8d84b19a2ec1298c8ddc775d74143afedffa0cd7c0e2975cea9e1e70d6631847&api_version=2025-01",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, variables }),
        },
      );

      const json = await resp.json();
      const node = json.data?.discountCodeBasicCreate?.codeDiscountNode;
      const actualCode =
        node?.codeDiscount?.codes?.nodes?.[0]?.code || codeName;

      const created = await prisma.discountCode.create({
        data: {
          id: `dcode_${Date.now()}_${partner.id.slice(-6)}`,
          code: actualCode,
          programId: discount.programId,
          partnerId: partner.id,
          linkId: defaultLink.id,
          discountId: discount.id,
        },
      });

      console.log(
        `✅ Successfully generated discount code "${created.code}" for partner ${partner.name} on link ${defaultLink.id}`,
      );
    } catch (err: any) {
      console.error(
        `Failed to create discount for ${partner.name}:`,
        err.message,
      );
    }
  }
}

main().finally(() => prisma.$disconnect());
