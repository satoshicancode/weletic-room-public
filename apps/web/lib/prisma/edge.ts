import { prisma, type ExtendedPrismaClient } from "./index";
import "../types/enums";

export const prismaEdge: ExtendedPrismaClient = prisma;
