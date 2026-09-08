import { triggerDraftBountySubmissionCreation } from "@/lib/bounty/api/trigger-draft-bounty-submissions";
import { qstash } from "@/lib/cron";
import { prisma } from "@/lib/prisma";
import { recordLink } from "@/lib/tinybird";
import { APP_DOMAIN_WITH_NGROK } from "@dub/utils";
import { PartnerGroup, Prisma, WorkspaceRole } from "@prisma/client";
import { waitUntil } from "@vercel/functions";
import { buildProgramEnrollmentChangeSet } from "../activity-log/build-program-enrollment-change-set";
import { getWorkspaceUsers } from "../get-workspace-users";
import { includeProgramEnrollment } from "../links/include-program-enrollment";
import { includeTags } from "../links/include-tags";
import { notifyPartnerGroupChange } from "../partners/notify-partner-group-change";

interface MovePartnersToGroupParams {
  workspaceId: string;
  programId: string;
  partnerIds: string[];
  userId: string | null;
  group: Pick<
    PartnerGroup,
    | "id"
    | "name"
    | "clickRewardId"
    | "leadRewardId"
    | "saleRewardId"
    | "referralRewardId"
    | "discountId"
  >;
  isGroupDeleted?: boolean;
  groupMoveDisabledAt?: Date | null;
}

export async function movePartnersToGroup({
  workspaceId,
  programId,
  partnerIds,
  userId,
  group,
  isGroupDeleted = false,
  groupMoveDisabledAt,
}: MovePartnersToGroupParams): Promise<number> {
  if (partnerIds.length === 0) {
    return 0;
  }

  const requestedPartnerIds = [...new Set(partnerIds)];
  const { count, programEnrollments } = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM ProgramEnrollment WHERE programId = ${programId} AND partnerId IN (${Prisma.join(requestedPartnerIds)}) FOR UPDATE`,
      );
      const lockedEnrollments = await tx.programEnrollment.findMany({
        where: {
          partnerId: { in: requestedPartnerIds },
          programId,
        },
        select: {
          id: true,
          partnerId: true,
          status: true,
          partnerGroup: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });
      if (lockedEnrollments.length === 0) {
        return { count: 0, programEnrollments: lockedEnrollments };
      }
      const lockedPartnerIds = lockedEnrollments.map(
        ({ partnerId }) => partnerId,
      );
      const update = await tx.programEnrollment.updateMany({
        where: {
          partnerId: {
            in: lockedPartnerIds,
          },
          programId,
        },
        data: {
          groupId: group.id,
          clickRewardId: group.clickRewardId,
          leadRewardId: group.leadRewardId,
          saleRewardId: group.saleRewardId,
          referralRewardId: group.referralRewardId,
          discountId: group.discountId,
          ...(groupMoveDisabledAt !== undefined && { groupMoveDisabledAt }),
        },
      });

      const activityLogs = lockedEnrollments.flatMap((enrollment) => {
        const changeSet = buildProgramEnrollmentChangeSet({
          oldEnrollment: enrollment,
          newEnrollment: {
            partnerGroup: { id: group.id, name: group.name },
          },
        });
        return Object.keys(changeSet).length > 0
          ? [
              {
                workspaceId,
                programId,
                resourceType: "partner",
                resourceId: enrollment.partnerId,
                userId,
                action: "partner.groupChanged",
                changeSet: changeSet as Prisma.InputJsonValue,
              },
            ]
          : [];
      });
      if (activityLogs.length > 0) {
        await tx.activityLog.createMany({ data: activityLogs });
      }
      return { count: update.count, programEnrollments: lockedEnrollments };
    },
  );

  if (count === 0) {
    return 0;
  }

  partnerIds = programEnrollments.map(({ partnerId }) => partnerId);

  waitUntil(
    (async () => {
      const partnerLinks = await prisma.link.findMany({
        where: {
          programId,
          partnerId: {
            in: partnerIds,
          },
        },
        include: {
          ...includeTags,
          ...includeProgramEnrollment,
        },
      });

      // If the userId is not provided, get the workspace user id from the workspace users
      // userId will be null for workflow-initiated actions
      let workspaceUserId = userId;

      if (!workspaceUserId) {
        const { users } = await getWorkspaceUsers({
          programId,
          role: WorkspaceRole.owner,
        });

        if (users.length > 0) {
          workspaceUserId = users[0].id;
        }
      }

      await Promise.allSettled([
        qstash.publishJSON({
          url: `${APP_DOMAIN_WITH_NGROK}/api/cron/groups/remap-default-links`,
          body: {
            programId,
            groupId: group.id,
            // skip remap-default-links / remap-discount-codes for pending applications (no links yet)
            partnerIds: programEnrollments
              .filter(({ status }) => status !== "pending")
              .map(({ partnerId }) => partnerId),
            userId: workspaceUserId,
            isGroupDeleted,
          },
        }),

        triggerDraftBountySubmissionCreation({
          programId,
          partnerIds,
        }),

        recordLink(partnerLinks),

        notifyPartnerGroupChange({
          programId,
          groupId: group.id,
          partnerIds,
        }),
      ]);
    })(),
  );

  return count;
}
