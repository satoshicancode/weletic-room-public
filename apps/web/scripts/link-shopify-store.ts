import "dotenv-flow/config";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const storeDomain = process.argv[2] || "yamaxdev.myshopify.com";
  console.log(`Linking store "${storeDomain}" to workspaces...`);

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
