// Opt-in SQL harness support, never production worker retry policy.
export interface ImportPollEvidence {
  applicationNow: number;
  databaseNow: number;
  job: {
    status: string;
    scheduledFor: number;
    nextRetryAt: number | null;
    attempts: number;
    lockedAt: number | null;
  } | null;
  source: {
    status: string;
    revision: number;
    leaseExpiresAt: number | null;
    completedRows: number;
  } | null;
}

interface PollResult {
  processed: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
}

const finite = (value: number | null) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const knownStatus = (value: string, allowed: string[]) =>
  allowed.includes(value) ? value : "unknown";

// Whitelist fields even when a caller accidentally supplies full database rows.
// Never spread or serialize raw evidence, worker results, IDs or payloads.
export function sanitizeImportPollEvidence(evidence: ImportPollEvidence) {
  return {
    timestampsValid:
      finite(evidence.applicationNow) !== null &&
      finite(evidence.databaseNow) !== null &&
      (!evidence.job ||
        (finite(evidence.job.scheduledFor) !== null &&
          [evidence.job.nextRetryAt, evidence.job.lockedAt].every(
            (value) => value === null || finite(value) !== null,
          ))) &&
      (!evidence.source ||
        evidence.source.leaseExpiresAt === null ||
        finite(evidence.source.leaseExpiresAt) !== null),
    applicationNow: finite(evidence.applicationNow),
    databaseNow: finite(evidence.databaseNow),
    job: evidence.job
      ? {
          status: knownStatus(evidence.job.status, [
            "pending",
            "processing",
            "completed",
            "failed",
            "dead_letter",
          ]),
          scheduledFor: finite(evidence.job.scheduledFor),
          nextRetryAt: finite(evidence.job.nextRetryAt),
          attempts: finite(evidence.job.attempts),
          lockedAt: finite(evidence.job.lockedAt),
        }
      : null,
    source: evidence.source
      ? {
          status: knownStatus(evidence.source.status, [
            "preview",
            "committing",
            "committed",
            "rolling_back",
            "rolled_back",
            "contained",
          ]),
          revision: finite(evidence.source.revision),
          leaseExpiresAt: finite(evidence.source.leaseExpiresAt),
          completedRows: finite(evidence.source.completedRows),
        }
      : null,
  };
}

export async function pollImportWorkerUntilEligible<T extends PollResult>({
  run,
  readEvidence,
  phase,
  previousRows,
  report,
  now = Date.now,
  monotonicNow = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  run: () => Promise<T>;
  readEvidence: () => Promise<ImportPollEvidence>;
  phase: "committing" | "rolling_back";
  previousRows: number;
  report: (evidence: ReturnType<typeof sanitizeImportPollEvidence>) => void;
  now?: () => number;
  monotonicNow?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<T> {
  const started = monotonicNow();
  for (let poll = 0; poll < 3; poll++) {
    const pollStarted = now();
    const result = await run();
    // Preserve the caller's exact success/failure assertions without retrying
    // errors, dead letters, malformed summaries or processed continuations.
    if (
      result.processed !== 0 ||
      result.succeeded !== 0 ||
      result.failed !== 0 ||
      result.deadLettered !== 0
    )
      return result;
    const evidence = sanitizeImportPollEvidence(await readEvidence());
    report(evidence);
    const { job, source, applicationNow, databaseNow } = evidence;
    const dueAt = Math.max(job?.scheduledFor ?? NaN, job?.nextRetryAt ?? 0);
    if (
      !job ||
      !source ||
      !evidence.timestampsValid ||
      applicationNow === null ||
      databaseNow === null ||
      job.status !== "pending" ||
      job.attempts !== 0 ||
      job.lockedAt !== null ||
      source.status !== phase ||
      source.revision === null ||
      !Number.isInteger(source.revision) ||
      source.revision < 0 ||
      source.completedRows !== previousRows ||
      (source.leaseExpiresAt !== null && source.leaseExpiresAt > databaseNow) ||
      !Number.isFinite(dueAt) ||
      dueAt <= pollStarted
    )
      throw new Error("Unexplained empty import poll; see sanitized evidence");
    const waitMs = Math.max(1, dueAt - now() + 1);
    if (poll === 2 || monotonicNow() - started + waitMs > 10_000)
      throw new Error("Import eligibility wait exceeded bounded poll budget");
    await sleep(waitMs);
  }
  throw new Error("Import eligibility poll budget exhausted");
}
