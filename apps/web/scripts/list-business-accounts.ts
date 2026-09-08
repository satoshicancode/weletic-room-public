import { prisma } from "@/lib/prisma";
import "dotenv-flow/config";

async function main() {
  const projects = await prisma.project.findMany({
    include: {
      users: {
        include: {
          user: true,
        },
      },
      programs: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`TOTAL_BUSINESS_ACCOUNTS: ${projects.length}`);
  console.log(
    JSON.stringify(
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        plan: p.plan,
        createdAt: p.createdAt,
        programs: p.programs.map((prog) => ({
          id: prog.id,
          name: prog.name,
          slug: prog.slug,
        })),
        members: p.users.map((u) => ({
          userId: u.userId,
          email: u.user.email,
          name: u.user.name,
          role: u.role,
        })),
      })),
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
