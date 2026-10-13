import "dotenv-flow/config";

async function main() {
  const storeDomain =
    process.argv[2] ||
    process.env.SHOPIFY_STORE_DOMAIN ||
    "example.myshopify.com";
  console.log(`Linking store "${storeDomain}" to workspaces...`);

  const { prisma } = await import("@/lib/prisma");
  await prisma.project.update({
    where: {
      slug: "we",
    },
    data: {
      shopifyStoreId: storeDomain,
    },
  });

  const updated = await prisma.project.findMany({
    where: {
      slug: {
        in: ["montsong", "we", "yamax"],
      },
    },
    select: {
      slug: true,
      name: true,
      shopifyStoreId: true,
    },
  });

  console.log(
    "Workspaces linked successfully:",
    JSON.stringify(updated, null, 2),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
