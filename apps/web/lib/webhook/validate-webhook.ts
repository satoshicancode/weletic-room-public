import { prisma } from "@/lib/prisma";
import { Webhook } from "@prisma/client";
import dns from "dns/promises";
import { isIP } from "net";
import * as z from "zod/v4";
import { DubApiError } from "../api/errors";
import { getDefaultProgramIdOrThrow } from "../api/programs/get-default-program-id-or-throw";
import { Session } from "../auth";
import { getFolders } from "../folder/get-folders";
import { WorkspaceProps } from "../types";
import { createWebhookSchema } from "../zod/schemas/webhooks";

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // fail-closed on malformed IPv4
  }
  return (
    parts[0] === 127 || // loopback 127.0.0.0/8
    parts[0] === 10 || // private 10.0.0.0/8
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || // private 172.16.0.0/12
    (parts[0] === 192 && parts[1] === 168) || // private 192.168.0.0/16
    (parts[0] === 169 && parts[1] === 254) || // link-local 169.254.0.0/16 (includes 169.254.169.254)
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || // CGNAT 100.64.0.0/10
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) || // Benchmark 198.18.0.0/15
    parts[0] >= 224 || // multicast 224.0.0.0/4 and reserved 240.0.0.0/4
    parts[0] === 0 // unspecified 0.0.0.0/8
  );
}

function parseIpv6Hextets(address: string): number[] | null {
  let clean = address
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();

  // Handle embedded IPv4 at the end, e.g. ::ffff:127.0.0.1 or 0:0:0:0:0:ffff:127.0.0.1
  const lastColon = clean.lastIndexOf(":");
  if (lastColon !== -1) {
    const afterLastColon = clean.slice(lastColon + 1);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(afterLastColon)) {
      const v4Parts = afterLastColon.split(".").map(Number);
      if (
        v4Parts.length === 4 &&
        v4Parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)
      ) {
        const hex1 = (((v4Parts[0] << 8) | v4Parts[1]) >>> 0).toString(16);
        const hex2 = (((v4Parts[2] << 8) | v4Parts[3]) >>> 0).toString(16);
        clean = `${clean.slice(0, lastColon)}:${hex1}:${hex2}`;
      } else {
        return null;
      }
    }
  }

  // Handle :: compression
  const doubleColonIndex = clean.indexOf("::");
  if (doubleColonIndex !== -1) {
    if (clean.indexOf("::", doubleColonIndex + 2) !== -1) {
      return null;
    }
    const leftStr = clean.slice(0, doubleColonIndex);
    const rightStr = clean.slice(doubleColonIndex + 2);
    const leftParts = leftStr ? leftStr.split(":") : [];
    const rightParts = rightStr ? rightStr.split(":") : [];
    const missing = 8 - (leftParts.length + rightParts.length);
    if (missing < 0) return null;
    const parts = [...leftParts, ...Array(missing).fill("0"), ...rightParts];
    if (parts.length !== 8) return null;
    const nums: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      nums.push(parseInt(part, 16));
    }
    return nums;
  } else {
    const parts = clean.split(":");
    if (parts.length !== 8) return null;
    const nums: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      nums.push(parseInt(part, 16));
    }
    return nums;
  }
}

function isPrivateIPv6(address: string): boolean {
  const nums = parseIpv6Hextets(address);
  if (!nums) {
    // If it cannot be parsed as standard IPv6, fail closed
    return true;
  }

  // Loopback: ::1 or 0:0:0:0:0:0:0:1
  const isLoopback = nums.slice(0, 7).every((n) => n === 0) && nums[7] === 1;

  // Unspecified: :: or 0:0:0:0:0:0:0:0
  const isUnspecified = nums.every((n) => n === 0);

  // IPv4-mapped (::ffff:x.x.x.x or 0:...:0:ffff:x.x.x.x)
  const isIpv4Mapped =
    nums.slice(0, 5).every((n) => n === 0) && nums[5] === 0xffff;

  // IPv4-compatible (::x.x.x.x)
  const isIpv4Compatible =
    nums.slice(0, 6).every((n) => n === 0) && !isLoopback && !isUnspecified;

  if (isIpv4Mapped || isIpv4Compatible) {
    const v4Str = `${(nums[6] >> 8) & 0xff}.${nums[6] & 0xff}.${(nums[7] >> 8) & 0xff}.${nums[7] & 0xff}`;
    if (isPrivateIPv4(v4Str)) {
      return true;
    }
  }

  // Unique local: fc00::/7 (fc00:: - fdff::)
  const isUniqueLocal = (nums[0] & 0xfe00) === 0xfc00;

  // Link-local: fe80::/10 (fe80:: - febf::)
  const isLinkLocal = (nums[0] & 0xffc0) === 0xfe80;

  return isLoopback || isUnspecified || isUniqueLocal || isLinkLocal;
}

function assertSafeWebhookIp(address: string): void {
  const cleanAddr = address.trim().replace(/^\[|\]$/g, "");

  const isRestricted = cleanAddr.includes(":")
    ? isPrivateIPv6(cleanAddr)
    : isPrivateIPv4(cleanAddr);

  if (isRestricted) {
    throw new DubApiError({
      code: "bad_request",
      message:
        "Webhook URL cannot point to a private, loopback, or metadata IP address.",
    });
  }
}

export async function assertSafeWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DubApiError({
      code: "bad_request",
      message: "Invalid webhook URL format.",
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DubApiError({
      code: "bad_request",
      message: "Webhook URL must use http or https protocol.",
    });
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    throw new DubApiError({
      code: "bad_request",
      message: "Webhook URL cannot point to localhost or internal hostnames.",
    });
  }

  const cleanHostname = hostname.replace(/^\[|\]$/g, "");

  let addresses: string[] = [];
  if (isIP(cleanHostname) !== 0) {
    addresses = [cleanHostname];
  } else {
    try {
      const records = await dns.lookup(cleanHostname, { all: true });
      addresses = records.map((r) => r.address);
    } catch {
      throw new DubApiError({
        code: "bad_request",
        message: "Webhook target host could not be resolved.",
      });
    }
  }

  if (addresses.length === 0) {
    throw new DubApiError({
      code: "bad_request",
      message: "Webhook target host did not resolve to any IP address.",
    });
  }

  for (const address of addresses) {
    assertSafeWebhookIp(address);
  }
}

export async function validateWebhook({
  input,
  workspace,
  webhook,
  user,
}: {
  input: Partial<z.infer<typeof createWebhookSchema>>;
  workspace: Pick<WorkspaceProps, "id" | "defaultProgramId">;
  webhook?: Webhook;
  user: Session["user"];
}) {
  const { url, linkScope, linkIds, folderIds, triggers } = input;

  // payout.confirmed trigger requires external payouts enabled
  if (triggers && triggers.includes("payout.confirmed")) {
    const programId = getDefaultProgramIdOrThrow(workspace);

    const program = await prisma.program.findUniqueOrThrow({
      where: {
        id: programId,
      },
      select: {
        payoutMode: true,
      },
    });

    // TODO: Maybe show this for all in the future?
    if (program.payoutMode === "internal") {
      throw new DubApiError({
        code: "bad_request",
        message: `The 'payout.confirmed' trigger is not currently available for your workspace.`,
      });
    }
  }

  if (url) {
    await assertSafeWebhookUrl(url);

    const webhookUrlExists = await prisma.webhook.findFirst({
      where: {
        projectId: workspace.id,
        url,
        ...(webhook && {
          id: {
            not: webhook.id,
          },
        }),
      },
    });

    if (webhookUrlExists) {
      throw new DubApiError({
        code: "conflict",
        message: "A Webhook with this URL already exists.",
      });
    }
  }

  if (linkScope === "links" && linkIds && linkIds.length > 0) {
    const folders = await getFolders({
      workspaceId: workspace.id,
      userId: user.id,
    });

    const links = await prisma.link.findMany({
      where: {
        id: {
          in: linkIds,
        },
        projectId: workspace.id,
        OR: [
          { folderId: null },
          { folderId: { in: folders.map((folder) => folder.id) } },
        ],
      },
      select: {
        id: true,
      },
    });

    if (links.length !== linkIds.length) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "Invalid link IDs provided. Please check the links you are adding the webhook to.",
      });
    }
  }

  if (linkScope === "folders" && folderIds && folderIds.length > 0) {
    const folders = await getFolders({
      workspaceId: workspace.id,
      userId: user.id,
    });

    const accessibleFolderIds = new Set(folders.map((folder) => folder.id));

    if (!folderIds.every((folderId) => accessibleFolderIds.has(folderId))) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "Invalid folder IDs provided. Please check the folders you are adding the webhook to.",
      });
    }
  }
}
