import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  escapeCsvCell,
  escapeCsvUntrustedTextCell,
} from "@/lib/weletic/loyalty/csv";
import { loyaltySuccessResponse } from "@/lib/weletic/loyalty/response";
import { WeleticPointsLedgerEntryType } from "@prisma/client";

const LEDGER_ENTRY_TYPES = new Set<string>(
  Object.values(WeleticPointsLedgerEntryType),
);
const MAX_PRISMA_SKIP = 2_147_483_647;

function badActivityQuery(message: string): never {
  throw new DubApiError({ code: "bad_request", message });
}

function parsePositiveIntegerQuery({
  value,
  field,
  defaultValue,
  maximum,
}: {
  value: unknown;
  field: "page" | "limit";
  defaultValue: number;
  maximum?: number;
}) {
  if (value === undefined || value === "") return defaultValue;
  const invalidMessage = maximum
    ? `${field} must be an integer between 1 and ${maximum}.`
    : `${field} must be a positive safe integer.`;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    badActivityQuery(invalidMessage);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (maximum !== undefined && parsed > maximum)
  ) {
    badActivityQuery(invalidMessage);
  }
  return parsed;
}

function parseLedgerEntryType(value: unknown) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !LEDGER_ENTRY_TYPES.has(value)) {
    badActivityQuery("type must be a valid loyalty ledger entry type.");
  }
  return value as WeleticPointsLedgerEntryType;
}

export const GET = withWorkspace(
  async ({ workspace, searchParams }) => {
    const search = searchParams.search || searchParams.query || "";
    const type = parseLedgerEntryType(searchParams.type);
    const format = searchParams.format;
    const page = parsePositiveIntegerQuery({
      value: searchParams.page,
      field: "page",
      defaultValue: 1,
    });
    const limit = parsePositiveIntegerQuery({
      value: searchParams.limit,
      field: "limit",
      defaultValue: 25,
      maximum: 100,
    });
    const skip = (page - 1) * limit;
    if (!Number.isSafeInteger(skip) || skip > MAX_PRISMA_SKIP) {
      badActivityQuery("page is too large for the requested limit.");
    }

    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
    });

    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const storeId = store.id;

    const where: any = {
      storeId,
      ...(type ? { entryType: type } : {}),
    };

    if (search.trim()) {
      where.OR = [
        {
          account: {
            shopper: {
              OR: [
                { email: { contains: search, mode: "insensitive" } },
                { firstName: { contains: search, mode: "insensitive" } },
                { lastName: { contains: search, mode: "insensitive" } },
              ],
            },
          },
        },
        { referenceId: { contains: search, mode: "insensitive" } },
        { reason: { contains: search, mode: "insensitive" } },
      ];
    }

    // CSV Export Mode (Owner Only Guard)
    if (format === "csv") {
      if (workspace.users[0].role !== "owner") {
        throw new DubApiError({
          code: "forbidden",
          message:
            "Only workspace owners are authorized to export the activity ledger to CSV.",
        });
      }

      const allEntries = await prisma.weleticPointsLedgerEntry.findMany({
        where,
        include: {
          account: {
            include: {
              shopper: {
                select: {
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
              currentTier: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 10000,
      });

      const headerRow =
        "Timestamp,Event Type,Customer Name,Email,Points Delta,Pending Delta,Balance After,Reference/Reason,VIP Tier";
      const rows = allEntries.map((entry) => {
        const timestamp = entry.createdAt
          ? new Date(entry.createdAt).toISOString()
          : "";
        const eventType = entry.entryType;
        const customerName =
          `${entry.account?.shopper?.firstName || ""} ${entry.account?.shopper?.lastName || ""}`.trim() ||
          "Shopper";
        const email = entry.account?.shopper?.email || "";
        const delta = entry.pointsDelta;
        const pointsDelta =
          delta > BigInt(0) ? `+${delta.toString()}` : delta.toString();
        const pending = entry.pendingDelta;
        const pendingDelta =
          pending > BigInt(0) ? `+${pending.toString()}` : pending.toString();
        const balanceAfter = entry.balanceAfter.toString();
        const refReason =
          entry.reason || entry.referenceId || entry.referenceType || "";
        const vipTier = entry.account?.currentTier?.name || "Bronze";

        return [
          escapeCsvCell(timestamp),
          escapeCsvCell(eventType),
          escapeCsvUntrustedTextCell(customerName),
          escapeCsvUntrustedTextCell(email),
          escapeCsvCell(pointsDelta),
          escapeCsvCell(pendingDelta),
          escapeCsvCell(balanceAfter),
          escapeCsvUntrustedTextCell(refReason),
          escapeCsvUntrustedTextCell(vipTier),
        ].join(",");
      });

      const csvContent = [headerRow, ...rows].join("\n");
      const dateStr = new Date().toISOString().split("T")[0];

      return new Response(csvContent, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="loyalty-activity-${storeId}-${dateStr}.csv"`,
        },
      });
    }

    const [entries, totalCount] = await Promise.all([
      prisma.weleticPointsLedgerEntry.findMany({
        where,
        include: {
          account: {
            include: {
              shopper: {
                select: {
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
              currentTier: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.weleticPointsLedgerEntry.count({ where }),
    ]);

    const serializedEntries = entries.map((entry) => ({
      id: entry.id,
      sequenceNumber: entry.sequenceNumber,
      entryType: entry.entryType,
      pointsDelta: entry.pointsDelta.toString(),
      pendingDelta: entry.pendingDelta.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      reason: entry.reason,
      createdAt: entry.createdAt,
      customer: entry.account?.shopper
        ? {
            name:
              `${entry.account.shopper.firstName || ""} ${entry.account.shopper.lastName || ""}`.trim() ||
              "Shopper",
            email: entry.account.shopper.email,
          }
        : null,
      tierName: entry.account?.currentTier?.name || "Bronze",
    }));

    return loyaltySuccessResponse(
      {
        entries: serializedEntries,
        pagination: {
          total: totalCount,
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit),
        },
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.read"],
  },
);

export const OPTIONS = () => {
  return new Response(null, {
    status: 204,
    headers: COMMON_CORS_HEADERS,
  });
};
