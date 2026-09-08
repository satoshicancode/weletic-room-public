import { prisma } from "@/lib/prisma";
import "dotenv-flow/config";

async function main() {
  console.log("Updating workspace groupsLimit and partnersLimit...");

  const result = await prisma.project.updateMany({
    where: {
      plan: "enterprise",
    },
    data: {
      groupsLimit: 100,
      partnersLimit: 1000,
      domainsLimit: 100,
      tagsLimit: 100,
    },
  });

  console.log("Updated workspaces count:", result.count);

  const workspaces = await prisma.project.findMany({
    select: {
      slug: true,
      plan: true,
      groupsLimit: true,
      partnersLimit: true,
      domainsLimit: true,
    },
  });

  console.log("Current Workspaces:", JSON.stringify(workspaces, null, 2));
}

main();
