import "../types/enums";
import { prisma, type ExtendedPrismaClient } from "./index";

export const prismaEdge: ExtendedPrismaClient = prisma;
