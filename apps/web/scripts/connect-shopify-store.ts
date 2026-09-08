import { prisma } from "@/lib/prisma";
import { syncWeleticShopifyCatalog } from "@/lib/weletic/shopify/catalog-sync";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import "dotenv-flow/config";

interface ConnectShopifyArgs {
  workspaceSlug: string;
  shopDomain: string;
  accessToken: string;
}

export async function connectShopifyStore({
  workspaceSlug,
  shopDomain,
  accessToken,
}: ConnectShopifyArgs) {
  // Normalize domain
  let cleanDomain = shopDomain.trim().toLowerCase();
  cleanDomain = cleanDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");

  console.log(
    `Connecting Shopify Store "${cleanDomain}" to Workspace "${workspaceSlug}"...`,
  );

  const workspace = await prisma.project.findUnique({
    where: { slug: workspaceSlug },
    include: {
      programs: true,
      users: {
        select: { userId: true },
        take: 1,
      },
    },
  });

  if (!workspace) {
    throw new Error(`Workspace with slug "${workspaceSlug}" not found!`);
  }

  if (!workspace.defaultProgramId) {
    throw new Error(
      `Workspace "${workspaceSlug}" does not have a default partner program! Please create a program first.`,
    );
  }

  const installer = workspace.users[0];
  if (!installer) {
    throw new Error(
      `Workspace "${workspaceSlug}" does not have a user who can own the integration installation.`,
    );
  }

  const scopes = [
    "read_products",
    "write_products",
    "read_markets",
    "read_orders",
    "read_translations",
    "read_discounts",
    "write_discounts",
    "read_price_rules",
    "write_price_rules",
  ].join(",");

  // 1. Update Project shopifyStoreId
  await prisma.project.update({
    where: { id: workspace.id },
    data: {
      shopifyStoreId: cleanDomain,
    },
  });

  // 2. Upsert InstalledIntegration
  const existingIntegration = await prisma.installedIntegration.findFirst({
    where: {
      projectId: workspace.id,
      integrationId: SHOPIFY_INTEGRATION_ID,
    },
  });

  const credentials = {
    accessToken,
    shop: cleanDomain,
    scope: scopes,
  };

  if (existingIntegration) {
    await prisma.installedIntegration.update({
      where: { id: existingIntegration.id },
      data: {
        credentials,
        updatedAt: new Date(),
      },
    });
    console.log("Updated existing Shopify integration credentials.");
  } else {
    await prisma.installedIntegration.create({
      data: {
        id: `int_shopify_${workspace.id}`,
        userId: installer.userId,
        projectId: workspace.id,
        integrationId: SHOPIFY_INTEGRATION_ID,
        credentials,
      },
    });
    console.log("Created new Shopify integration record.");
  }

  console.log("Starting full Shopify Catalog sync...");
  const syncResult = await syncWeleticShopifyCatalog({
    workspaceId: workspace.id,
  });

  console.log("Catalog Sync Completed Successfully!");
  console.log(JSON.stringify(syncResult, null, 2));

  // Fetch summary of synced products
  const productsCount = await prisma.weleticShopifyProduct.count({
    where: {
      store: {
        projectId: workspace.id,
      },
    },
  });

  const marketsCount = await prisma.weleticShopifyMarket.count({
    where: {
      store: {
        projectId: workspace.id,
      },
    },
  });

  console.log(`\n🎉 Summary:`);
  console.log(`- Markets synced: ${marketsCount}`);
  console.log(`- Products synced: ${productsCount}`);
  console.log(
    `- View on Partner Portal: http://partners.localhost:8888/programs/${workspace.slug}/products`,
  );

  return { syncResult, productsCount, marketsCount };
}

// Allow running directly from CLI: tsx scripts/connect-shopify-store.ts <workspaceSlug> <shopDomain> <accessToken>
if (process.argv[2] && process.argv[3] && process.argv[4]) {
  const [workspaceSlug, shopDomain, accessToken] = process.argv.slice(2);
  connectShopifyStore({ workspaceSlug, shopDomain, accessToken })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Failed to connect Shopify store:", err);
      process.exit(1);
    });
}
