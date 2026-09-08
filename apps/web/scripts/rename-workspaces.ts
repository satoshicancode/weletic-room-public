import { prisma } from "@/lib/prisma";
import "dotenv-flow/config";

async function main() {
  console.log("Starting workspace and program renaming...");

  await prisma.$transaction(async (tx) => {
    // 1. Rename Workspace: Weletic Secondary (slug: we, id: ws_1KETZ919F83ZJH6A80HWEHW6E) -> Montsong (slug: montsong)
    const ws2 = await tx.project.findFirst({
      where: {
        OR: [{ id: "ws_1KETZ919F83ZJH6A80HWEHW6E" }, { slug: "we" }],
      },
    });

    if (ws2) {
      console.log(
        `Found Workspace 2 (${ws2.id}, current slug: ${ws2.slug}) -> renaming to Montsong (slug: montsong)...`,
      );
      await tx.project.update({
        where: { id: ws2.id },
        data: {
          name: "Montsong",
          slug: "montsong",
        },
      });

      // Also update linked Program if any
      await tx.program.updateMany({
        where: { workspaceId: ws2.id },
        data: {
          name: "Montsong",
          slug: "montsong",
        },
      });

      // Update User defaultWorkspace from "we" to "montsong"
      await tx.user.updateMany({
        where: { defaultWorkspace: "we" },
        data: { defaultWorkspace: "montsong" },
      });
    }

    // 2. Rename Workspace: Weletic (slug: weletic, id: ws_1KZQN7A1KJB60ZZJQ9N1D2PX0) -> Yamax (slug: yamax)
    const ws1 = await tx.project.findFirst({
      where: {
        OR: [{ id: "ws_1KZQN7A1KJB60ZZJQ9N1D2PX0" }, { slug: "weletic" }],
      },
    });

    if (ws1) {
      console.log(
        `Found Workspace 1 (${ws1.id}, current slug: ${ws1.slug}) -> renaming to Yamax (slug: yamax)...`,
      );
      await tx.project.update({
        where: { id: ws1.id },
        data: {
          name: "Yamax",
          slug: "yamax",
        },
      });

      // Also update linked Program if any
      await tx.program.updateMany({
        where: { workspaceId: ws1.id },
        data: {
          name: "Yamax",
          slug: "yamax",
        },
      });

      // Update User defaultWorkspace from "weletic" to "yamax"
      await tx.user.updateMany({
        where: { defaultWorkspace: "weletic" },
        data: { defaultWorkspace: "yamax" },
      });
    }

    // 3. Rename Workspace: Dub Core Admin (id: cl7pj5kq4006835rbjlt2ofka) -> Weletic Core Admin (slug: we)
    const ws3 = await tx.project.findFirst({
      where: {
        OR: [{ id: "cl7pj5kq4006835rbjlt2ofka" }, { slug: "dub" }],
      },
    });

    if (ws3) {
      console.log(
        `Found Root Workspace (${ws3.id}, current slug: ${ws3.slug}) -> renaming to Weletic Core Admin (slug: we)...`,
      );
      await tx.project.update({
        where: { id: ws3.id },
        data: {
          name: "Weletic Core Admin",
          slug: "we",
        },
      });

      await tx.program.updateMany({
        where: { workspaceId: ws3.id },
        data: {
          name: "Weletic Core Admin",
          slug: "we",
        },
      });

      await tx.user.updateMany({
        where: { defaultWorkspace: "dub" },
        data: { defaultWorkspace: "we" },
      });
    }
  });

  console.log("Renaming transaction completed successfully!");

  // Verify
  const projects = await prisma.project.findMany({
    include: {
      programs: true,
      users: {
        include: {
          user: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(
    "VERIFIED_PROJECTS:",
    JSON.stringify(
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        programs: p.programs.map((pr) => ({ name: pr.name, slug: pr.slug })),
        users: p.users.map((u) => ({ email: u.user.email, role: u.role })),
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
