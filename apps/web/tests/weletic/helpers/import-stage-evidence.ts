// Isolated harness only. Error markers are observations, not root-cause proof.
const stages = [
  "commit_recovery",
  "commit_batch",
  "commit_continuation",
  "rollback_recovery",
  "rollback_batch",
  "rollback_continuation",
] as const;
export type ImportStage = (typeof stages)[number];
function ownString(value: unknown, key: string) {
  if (!value || typeof value !== "object") return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return typeof descriptor?.value === "string" ? descriptor.value : null;
}
export function importStageEvidence(stage: ImportStage, error: unknown) {
  const code = ownString(error, "code");
  const name = ownString(error, "name");
  return {
    stage: stages.includes(stage) ? stage : "unknown",
    // Never emit message, meta, cause, stack, arguments, identifiers or SQL.
    prismaCode:
      code &&
      [
        "P1001",
        "P1002",
        "P1008",
        "P1017",
        "P2002",
        "P2024",
        "P2028",
        "P2034",
      ].includes(code)
        ? code
        : null,
    errorKind:
      name &&
      [
        "HistoricalImportConflictError",
        "HistoricalImportExecutionContainedError",
        "HistoricalImportLeasePendingError",
        "PrismaClientKnownRequestError",
        "PrismaClientUnknownRequestError",
        "PrismaClientInitializationError",
      ].includes(name)
        ? name
        : "unclassified",
  };
}
export async function observeImportStage<T>(
  stage: ImportStage,
  run: () => Promise<T>,
  report: (evidence: ReturnType<typeof importStageEvidence>) => void,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Diagnostics must not replace the actual error or trigger another attempt.
    try {
      report(importStageEvidence(stage, error));
    } catch {
      /* Preserve original failure. */
    }
    throw error;
  }
}
