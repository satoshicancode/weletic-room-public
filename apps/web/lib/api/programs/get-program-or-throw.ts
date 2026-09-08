import { metadataCache } from "@/lib/api/metadata-cache";
import { prisma } from "@/lib/prisma";
import { ProgramSchemaWithInviteEmailData } from "@/lib/zod/schemas/programs";
import { Prisma } from "@prisma/client";
import * as z from "zod/v4";
import { DubApiError } from "../errors";

type ProgramWithInclude<T extends Prisma.ProgramInclude = {}> = z.infer<
  typeof ProgramSchemaWithInviteEmailData
> &
  Prisma.ProgramGetPayload<{ include: T }>;

const cachedDateSchema = z.union([
  z.date(),
  z.iso.datetime().transform((value) => new Date(value)),
]);

const CachedProgramSchema = ProgramSchemaWithInviteEmailData.extend({
  addedToMarketplaceAt: cachedDateSchema.nullish(),
  messagingEnabledAt: cachedDateSchema.nullish(),
  partnerNetworkEnabledAt: cachedDateSchema.nullish(),
  createdAt: cachedDateSchema,
  updatedAt: cachedDateSchema,
  startedAt: cachedDateSchema.nullish(),
  deactivatedAt: cachedDateSchema.nullish(),
}).passthrough();

function canCacheProgramInclude(include?: Prisma.ProgramInclude): boolean {
  return (
    !include ||
    (Object.keys(include).length === 1 && include.categories === true)
  );
}

export async function getProgramOrThrow<T extends Prisma.ProgramInclude = {}>({
  workspaceId,
  programId,
  include,
}: {
  workspaceId: string;
  programId: string;
  include?: T;
}): Promise<ProgramWithInclude<T>> {
  const canUseCache = canCacheProgramInclude(include);
  const includeKey = include ? JSON.stringify(include) : "default";
  const cached = canUseCache
    ? await metadataCache.getProgram<ProgramWithInclude<T>>(
        workspaceId,
        programId,
        includeKey,
      )
    : null;
  if (cached) {
    const parsed = CachedProgramSchema.safeParse(cached);
    if (parsed.success) {
      return parsed.data as ProgramWithInclude<T>;
    }
  }

  const program = await prisma.program.findUnique({
    where: {
      id: programId,
    },
    include,
  });

  if (!program || program.workspaceId !== workspaceId) {
    throw new DubApiError({
      code: "not_found",
      message: "Program not found.",
    });
  }

  // Transform categories if included
  const transformedProgram =
    include?.categories && "categories" in program
      ? {
          ...program,
          // @ts-ignore conditionally transforming categories
          categories: program.categories?.map(({ category }) => category) ?? [],
        }
      : program;

  const result = transformedProgram as ProgramWithInclude<T>;
  if (canUseCache) {
    await metadataCache.setProgram(workspaceId, programId, result, includeKey);
  }

  return result;
}
