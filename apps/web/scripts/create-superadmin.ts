import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/prisma";
import { DUB_WORKSPACE_ID } from "@dub/utils";
import "dotenv-flow/config";

async function main() {
  console.log("Creating Superadmin user...");

  // 1. Ensure root workspace exists
  let rootProject = await prisma.project.findUnique({
    where: { id: DUB_WORKSPACE_ID },
  });

  if (!rootProject) {
    console.log(`Creating root workspace with ID: ${DUB_WORKSPACE_ID}...`);
    rootProject = await prisma.project.create({
      data: {
        id: DUB_WORKSPACE_ID,
        name: "Dub Core Admin",
        slug: "dub",
        plan: "enterprise",
        billingCycleStart: 1,
      },
    });
  } else {
    console.log(
      `Found existing root workspace: ${rootProject.name} (${rootProject.slug})`,
    );
  }

  // 2. Hash password "admin"
  const passwordHash = await hashPassword("admin");

  // 3. Upsert superadmin user
  const email = "admin@weletic.com";
  const user = await prisma.user.upsert({
    where: { email },
    update: {
      passwordHash,
      emailVerified: new Date(),
      name: "Super Admin",
    },
    create: {
      email,
      name: "Super Admin",
      passwordHash,
      emailVerified: new Date(),
    },
  });

  console.log(`User created/updated: ${user.email} (ID: ${user.id})`);

  // 4. Link user as owner of root workspace
  await prisma.projectUsers.upsert({
    where: {
      userId_projectId: {
        userId: user.id,
        projectId: DUB_WORKSPACE_ID,
      },
    },
    update: {
      role: "owner",
    },
    create: {
      userId: user.id,
      projectId: DUB_WORKSPACE_ID,
      role: "owner",
    },
  });

  console.log(
    `Successfully assigned ${user.email} as OWNER of root workspace (${DUB_WORKSPACE_ID})!`,
  );
  console.log("SUPERADMIN_READY");
}

main()
  .catch((e) => {
    console.error("Error creating superadmin:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
