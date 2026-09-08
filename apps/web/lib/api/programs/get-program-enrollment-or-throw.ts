import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { DubApiError } from "../errors";

// Type-safe version that accepts an include object directly
export async function getProgramEnrollmentOrThrow<
  T extends Prisma.ProgramEnrollmentInclude,
>({
  partnerId,
  programId,
  include,
  status = "active",
}: {
  partnerId: string;
  programId: string;
  include: T;
  status?: "active" | "archived" | "all";
}): Promise<Prisma.ProgramEnrollmentGetPayload<{ include: T }>> {
  const discountCodesWhere =
    status === "archived"
      ? { disabledAt: { not: null } }
      : status === "all"
        ? {}
        : { disabledAt: null };

  const discountCodesInclude =
    typeof include.discountCodes === "object"
      ? {
          ...include.discountCodes,
          where: {
            ...include.discountCodes.where,
            ...discountCodesWhere,
          },
        }
      : include.discountCodes
        ? {
            where: discountCodesWhere,
          }
        : false;

  const finalInclude = {
    ...include,
    discountCodes: discountCodesInclude,
    links: include.links
      ? {
          orderBy: {
            createdAt: "asc",
          },
          include: {
            discountCode: true,
          },
        }
      : false,
  };

  const programEnrollment = programId.startsWith("prog_")
    ? await prisma.programEnrollment.findUnique({
        where: {
          partnerId_programId: {
            partnerId,
            programId,
          },
        },
        include: finalInclude,
      })
    : await prisma.programEnrollment.findFirst({
        where: {
          partnerId,
          program: {
            slug: programId,
          },
        },
        include: finalInclude,
      });

  if (!programEnrollment) {
    throw new DubApiError({
      code: "not_found",
      message: `Partner ${partnerId} is not enrolled in program ${programId}.`,
    });
  }

  return programEnrollment as Prisma.ProgramEnrollmentGetPayload<{
    include: T;
  }>;
}
