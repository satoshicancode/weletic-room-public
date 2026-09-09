import { useEffect, useRef, useState } from "react";
import type { verifyHistoricalImportReconciliationResponse } from "../../../apps/web/lib/weletic/loyalty/historical-import-contract";
import { importReconciliationCopy } from "./import-reconciliation-copy";
type Result = ReturnType<typeof verifyHistoricalImportReconciliationResponse>;
export type ReconcileImport = (request: unknown) => Promise<Result>;
/** Remounted by the parent on every status refresh, not only revision changes. */
export function ImportReconciliationPanel({
  sourceId,
  generation,
  revision,
  locale,
  reconcile,
}: {
  sourceId: string;
  generation: string;
  revision: string;
  locale: keyof typeof importReconciliationCopy;
  reconcile: ReconcileImport;
}) {
  const text = importReconciliationCopy[locale];
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  async function run() {
    if (running.current) return;
    const version = epoch.current;
    running.current = true;
    setBusy(true);
    setFailed(false);
    setResult(null);
    try {
      const value = await reconcile({
        operation: "reconcile",
        sourceId,
        expectedInstallationGeneration: generation,
        expectedRevision: revision,
      });
      if (epoch.current === version) setResult(value);
    } catch {
      if (epoch.current === version) setFailed(true);
    } finally {
      if (epoch.current === version) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section aria-busy={busy}>
      <h3>{text.title}</h3>
      <p>{text.notice}</p>
      <button disabled={busy} onClick={() => void run()}>
        {text.run}
      </button>
      <p role="status" aria-live="polite">
        {busy
          ? text.busy
          : failed
            ? text.error
            : result
              ? !result.reconciled
                ? text.mismatch
                : result.fullyCommitted
                  ? text.committed
                  : result.fullyRolledBack
                    ? text.rolledBack
                    : text.clean
              : ""}
      </p>
      {result && (
        <>
          <dl>
            <dt>{text.imported}</dt>
            <dd>{result.importedPoints}</dd>
            <dt>{text.reversed}</dt>
            <dd>{result.reversedPoints}</dd>
            <dt>{text.expected}</dt>
            <dd>{result.expectedNetPoints}</dd>
            <dt>{text.observed}</dt>
            <dd>{result.observedNetPoints}</dd>
          </dl>
          {result.issues.length > 0 && (
            <ul>
              {result.issues.map((issue) => (
                <li key={issue}>{text.issues[issue]}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
