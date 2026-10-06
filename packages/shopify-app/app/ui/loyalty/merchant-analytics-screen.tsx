import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { merchantAccountRowCsv } from "@weletic/contracts/loyalty/account-row-csv";
import {
  merchantAccountRowExportRequestSchema,
  type MerchantAccountRowExportRequest,
  type MerchantAccountRowExportResponse,
} from "@weletic/contracts/loyalty/account-row-export-contract";
import { merchantLedgerRowCsv } from "@weletic/contracts/loyalty/ledger-row-csv";
import {
  merchantLedgerRowExportRequestSchema,
  type MerchantLedgerRowExportRequest,
  type MerchantLedgerRowExportResponse,
} from "@weletic/contracts/loyalty/ledger-row-export-contract";
import {
  merchantAnalyticsFilterSchema,
  type MerchantAnalyticsRequest,
  type MerchantAnalyticsResponse,
  type MerchantAnalyticsSnapshot,
} from "@weletic/contracts/loyalty/merchant-analytics-contract";
import { merchantRedemptionRowCsv } from "@weletic/contracts/loyalty/redemption-row-csv";
import {
  merchantRedemptionRowExportRequestSchema,
  type MerchantRedemptionRowExportRequest,
  type MerchantRedemptionRowExportResponse,
} from "@weletic/contracts/loyalty/redemption-row-export-contract";
import { merchantTierHistoryCsv } from "@weletic/contracts/loyalty/tier-history-csv";
import type {
  MerchantTierHistoryExportRequest,
  MerchantTierHistoryExportResponse,
} from "@weletic/contracts/loyalty/tier-history-export-contract";
import { merchantTierHistoryExportRequestSchema } from "@weletic/contracts/loyalty/tier-history-export-contract";
import React, { useRef, useState } from "react";
import { merchantAnalyticsCopy } from "./merchant-analytics-copy";

export type MerchantAnalyticsTransport = (
  request: MerchantAnalyticsRequest,
) => Promise<MerchantAnalyticsResponse>;
export type MerchantTierHistoryTransport = (
  request: MerchantTierHistoryExportRequest,
) => Promise<MerchantTierHistoryExportResponse>;
export type MerchantLedgerRowTransport = (
  request: MerchantLedgerRowExportRequest,
) => Promise<MerchantLedgerRowExportResponse>;
export type MerchantRedemptionRowTransport = (
  request: MerchantRedemptionRowExportRequest,
) => Promise<MerchantRedemptionRowExportResponse>;
export type MerchantAccountRowTransport = (
  request: MerchantAccountRowExportRequest,
) => Promise<MerchantAccountRowExportResponse>;

function download(content: string, contentType: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function MerchantAnalyticsScreen({
  request,
  requestTierHistory,
  requestLedgerRows,
  requestRedemptionRows,
  requestAccountRows,
}: {
  request: MerchantAnalyticsTransport;
  requestTierHistory?: MerchantTierHistoryTransport;
  requestLedgerRows?: MerchantLedgerRowTransport;
  requestRedemptionRows?: MerchantRedemptionRowTransport;
  requestAccountRows?: MerchantAccountRowTransport;
}) {
  const [locale, setLocale] =
    useState<keyof typeof merchantAnalyticsCopy>("en");
  const copy = merchantAnalyticsCopy[locale];
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [snapshot, setSnapshot] = useState<MerchantAnalyticsSnapshot | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"invalid" | "error" | "tooMany" | null>(
    null,
  );
  const epoch = useRef(0);
  React.useEffect(() => {
    const fence = epoch;
    const version = ++epoch.current;
    setStart("");
    setEnd("");
    setSnapshot(null);
    setError(null);
    setBusy(true);
    request({ operation: "read", filter: { startAt: null, endAt: null } })
      .then(
        (result) => {
          if (version === epoch.current) setSnapshot(result.snapshot);
        },
        () => {
          if (version === epoch.current) setError("error");
        },
      )
      .finally(() => {
        if (version === epoch.current) setBusy(false);
      });
    return () => {
      fence.current++;
    };
  }, [request]);

  async function run(format?: "csv" | "json") {
    const filter = merchantAnalyticsFilterSchema.safeParse({
      startAt: start ? `${start}T00:00:00.000Z` : null,
      endAt: end ? `${end}T23:59:59.999Z` : null,
    });
    if (!filter.success) {
      setError("invalid");
      return;
    }
    if (format && !snapshot?.canExport) return;
    const version = ++epoch.current;
    setBusy(true);
    setError(null);
    setSnapshot(null);
    try {
      const result = await request(
        format
          ? {
              operation: "export",
              filter: filter.data,
              format,
              expectedInstallationGeneration: snapshot!.installationGeneration,
            }
          : { operation: "read", filter: filter.data },
      );
      if (version !== epoch.current) return;
      setSnapshot(result.snapshot);
      if (result.download) {
        download(
          result.download.content,
          result.download.contentType,
          result.download.filename,
        );
      }
    } catch {
      if (version === epoch.current) setError("error");
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  async function exportTierHistory() {
    if (!snapshot?.canExport || !requestTierHistory || !start || !end) {
      setError("invalid");
      return;
    }
    const parsed = merchantTierHistoryExportRequestSchema.safeParse({
      filter: {
        startAt: `${start}T00:00:00.000Z`,
        endAt: `${end}T23:59:59.999Z`,
      },
      expectedInstallationGeneration: snapshot.installationGeneration,
    });
    if (!parsed.success) {
      setError("invalid");
      return;
    }
    const version = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const result = await requestTierHistory(parsed.data);
      if (version !== epoch.current) return;
      if (result.status === "too_large") {
        setError("tooMany");
        return;
      }
      download(
        merchantTierHistoryCsv(result.rows),
        "text/csv;charset=utf-8",
        `weletic-tier-history-${start}-${end}.csv`,
      );
    } catch {
      if (version === epoch.current) setError("error");
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  async function exportLedgerRows() {
    if (!snapshot?.canExport || !requestLedgerRows || !start || !end) {
      setError("invalid");
      return;
    }
    const parsed = merchantLedgerRowExportRequestSchema.safeParse({
      filter: {
        startAt: `${start}T00:00:00.000Z`,
        endAt: `${end}T23:59:59.999Z`,
      },
      expectedInstallationGeneration: snapshot.installationGeneration,
    });
    if (!parsed.success) {
      setError("invalid");
      return;
    }
    const version = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const result = await requestLedgerRows(parsed.data);
      if (version !== epoch.current) return;
      if (result.status === "too_large") {
        setError("tooMany");
        return;
      }
      download(
        merchantLedgerRowCsv(result.rows),
        "text/csv;charset=utf-8",
        `weletic-points-transactions-${start}-${end}.csv`,
      );
    } catch {
      if (version === epoch.current) setError("error");
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  async function exportRedemptionRows() {
    if (!snapshot?.canExport || !requestRedemptionRows || !start || !end) {
      setError("invalid");
      return;
    }
    const parsed = merchantRedemptionRowExportRequestSchema.safeParse({
      filter: {
        startAt: `${start}T00:00:00.000Z`,
        endAt: `${end}T23:59:59.999Z`,
      },
      expectedInstallationGeneration: snapshot.installationGeneration,
    });
    if (!parsed.success) {
      setError("invalid");
      return;
    }
    const version = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const result = await requestRedemptionRows(parsed.data);
      if (version !== epoch.current) return;
      if (result.status === "too_large") {
        setError("tooMany");
        return;
      }
      download(
        merchantRedemptionRowCsv(result.rows),
        "text/csv;charset=utf-8",
        `weletic-recorded-redemptions-${start}-${end}.csv`,
      );
    } catch {
      if (version === epoch.current) setError("error");
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  async function exportAccountRows() {
    if (!snapshot?.canExport || !requestAccountRows || !start || !end) {
      setError("invalid");
      return;
    }
    const parsed = merchantAccountRowExportRequestSchema.safeParse({
      filter: {
        startAt: `${start}T00:00:00.000Z`,
        endAt: `${end}T23:59:59.999Z`,
      },
      expectedInstallationGeneration: snapshot.installationGeneration,
    });
    if (!parsed.success) {
      setError("invalid");
      return;
    }
    const version = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const result = await requestAccountRows(parsed.data);
      if (version !== epoch.current) return;
      if (result.status === "too_large") {
        setError("tooMany");
        return;
      }
      download(
        merchantAccountRowCsv(result.rows),
        "text/csv;charset=utf-8",
        `weletic-current-accounts-${start}-${end}.csv`,
      );
    } catch {
      if (version === epoch.current) setError("error");
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  const label = (key: string) => copy[key as keyof typeof copy] ?? key;
  const rate = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const wholeRate = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  function formatBasisPoints(value: string) {
    const basisPoints = BigInt(value);
    const whole = wholeRate.format(basisPoints / BigInt(100));
    const fraction = (basisPoints % BigInt(100)).toString().padStart(2, "0");
    return rate
      .formatToParts(1)
      .map((part) =>
        part.type === "integer"
          ? whole
          : part.type === "fraction"
            ? fraction
            : part.value,
      )
      .join("");
  }
  function table(title: string, rows: Record<string, string | null>[]) {
    const keys = rows[0] ? Object.keys(rows[0]) : [];
    return (
      <section>
        <h2>{title}</h2>
        {rows.length ? (
          <div
            role="region"
            aria-label={title}
            tabIndex={0}
            style={{ overflowX: "auto" }}
          >
            <table>
              <thead>
                <tr>
                  {keys.map((key) => (
                    <th key={key} scope="col">
                      {label(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    {keys.map((key) => (
                      <td key={key}>
                        {row[key] === null
                          ? copy.unavailable
                          : key === "rateBasisPoints" ||
                              key === "redemptionRateBasisPoints"
                            ? formatBasisPoints(row[key]!)
                            : key === "status" ||
                                key === "artifact" ||
                                key === "entryType" ||
                                key === "rewardType"
                              ? row[key] === "expired"
                                ? copy.expiredStatus
                                : label(row[key]!)
                              : row[key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>{copy.empty}</p>
        )}
      </section>
    );
  }
  function metrics(title: string, values: Record<string, string | null>) {
    return (
      <section>
        <h2>{title}</h2>
        <dl>
          {Object.entries(values).map(([key, value]) => (
            <div key={key}>
              <dt>{label(key)}</dt>
              <dd>{value ?? copy.unavailable}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }
  return (
    <article
      className="weletic-analytics"
      lang={locale}
      aria-busy={busy}
      style={{ maxWidth: "100%", overflowWrap: "anywhere" }}
    >
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h1" variant="headingLg">
            {copy.title}
          </Text>
          <div style={{ minWidth: 150 }}>
            <Select
              label={copy.language}
              labelHidden
              options={[
                { label: "English", value: "en" },
                { label: "日本語", value: "ja" },
                { label: "Tiếng Việt", value: "vi" },
              ]}
              value={locale}
              onChange={(val) =>
                setLocale(val as keyof typeof merchantAnalyticsCopy)
              }
            />
          </div>
        </InlineStack>
        <Text as="p" tone="subdued">
          {copy.semantics}
        </Text>
        <Card>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <BlockStack gap="300">
              <TextField
                label={copy.start}
                type="date"
                autoComplete="off"
                value={start}
                disabled={busy}
                onChange={(val) => {
                  setStart(val);
                  setSnapshot(null);
                  setError(null);
                }}
              />
              <TextField
                label={copy.end}
                type="date"
                autoComplete="off"
                value={end}
                disabled={busy}
                onChange={(val) => {
                  setEnd(val);
                  setSnapshot(null);
                  setError(null);
                }}
              />
              <InlineStack gap="300">
                <Button submit variant="primary" disabled={busy}>
                  {copy.refresh}
                </Button>
              </InlineStack>
            </BlockStack>
          </form>
        </Card>
        {busy && <p role="status">{copy.loading}</p>}
        {error && (
          <Banner tone="critical">
            <p role="alert">{copy[error]}</p>
          </Banner>
        )}
        {snapshot && (
          <>
            <p>
              {copy.currency}: {snapshot.currency} · {copy.generated}:{" "}
              {snapshot.generatedAt}
            </p>
            {snapshot.financialStatus !== "available" && (
              <p role="status">{copy.financial}</p>
            )}
            <button
              type="button"
              disabled={busy || !snapshot.canExport}
              onClick={() => void run("csv")}
            >
              {copy.csv}
            </button>{" "}
            <button
              type="button"
              disabled={busy || !snapshot.canExport}
              onClick={() => void run("json")}
            >
              {copy.json}
            </button>
            {!snapshot.canExport && <p>{copy.exportNote}</p>}
            {requestAccountRows && (
              <section>
                <h2>{copy.accountRowsTitle}</h2>
                <p>{copy.accountRowsSemantics}</p>
                <button
                  type="button"
                  disabled={busy || !snapshot.canExport || !start || !end}
                  onClick={() => void exportAccountRows()}
                >
                  {copy.accountRowsCsv}
                </button>
              </section>
            )}
            {requestTierHistory && (
              <section>
                <h2>{copy.tierHistoryTitle}</h2>
                <p>{copy.tierHistorySemantics}</p>
                <button
                  type="button"
                  disabled={busy || !snapshot.canExport || !start || !end}
                  onClick={() => void exportTierHistory()}
                >
                  {copy.tierHistoryCsv}
                </button>
              </section>
            )}
            {requestLedgerRows && (
              <section>
                <h2>{copy.ledgerRowsTitle}</h2>
                <p>{copy.ledgerRowsSemantics}</p>
                <button
                  type="button"
                  disabled={busy || !snapshot.canExport || !start || !end}
                  onClick={() => void exportLedgerRows()}
                >
                  {copy.ledgerRowsCsv}
                </button>
              </section>
            )}
            {requestRedemptionRows && (
              <section>
                <h2>{copy.redemptionRowsTitle}</h2>
                <p>{copy.redemptionRowsSemantics}</p>
                <button
                  type="button"
                  disabled={busy || !snapshot.canExport || !start || !end}
                  onClick={() => void exportRedemptionRows()}
                >
                  {copy.redemptionRowsCsv}
                </button>
              </section>
            )}
            {metrics(copy.liability, snapshot.liability)}
            {metrics(copy.activity, snapshot.activity)}
            {snapshot.activitySeries.status === "available" ? (
              table(copy.activitySeries, snapshot.activitySeries.rows)
            ) : (
              <section>
                <h2>{copy.activitySeries}</h2>
                <p role="status">{copy[snapshot.activitySeries.status]}</p>
              </section>
            )}
            <p>{copy.ledgerNetSemantics}</p>
            {snapshot.ledgerNetSeries.status === "available" ? (
              <>
                {metrics(copy.ledgerNetOpening, {
                  openingNetPoints: snapshot.ledgerNetSeries.openingNetPoints,
                })}
                {table(copy.ledgerNetSeries, snapshot.ledgerNetSeries.rows)}
              </>
            ) : (
              <section>
                <h2>{copy.ledgerNetSeries}</h2>
                <p role="status">{copy[snapshot.ledgerNetSeries.status]}</p>
              </section>
            )}
            <p>{copy.firstRecordedEarnersSemantics}</p>
            {snapshot.firstRecordedEarnersSeries.status === "available" ? (
              table(
                copy.firstRecordedEarnersSeries,
                snapshot.firstRecordedEarnersSeries.rows,
              )
            ) : (
              <section>
                <h2>{copy.firstRecordedEarnersSeries}</h2>
                <p role="status">
                  {copy[snapshot.firstRecordedEarnersSeries.status]}
                </p>
              </section>
            )}
            <p>{copy.firstRecordedRedemptionDebitsSemantics}</p>
            {snapshot.firstRecordedRedemptionDebitsSeries.status ===
            "available" ? (
              table(
                copy.firstRecordedRedemptionDebitsSeries,
                snapshot.firstRecordedRedemptionDebitsSeries.rows,
              )
            ) : (
              <section>
                <h2>{copy.firstRecordedRedemptionDebitsSeries}</h2>
                <p role="status">
                  {copy[snapshot.firstRecordedRedemptionDebitsSeries.status]}
                </p>
              </section>
            )}
            <p>{copy.firstRecordedConfirmedIssuancesSemantics}</p>
            {snapshot.firstRecordedConfirmedIssuancesSeries.status ===
            "available" ? (
              table(
                copy.firstRecordedConfirmedIssuancesSeries,
                snapshot.firstRecordedConfirmedIssuancesSeries.rows,
              )
            ) : (
              <section>
                <h2>{copy.firstRecordedConfirmedIssuancesSeries}</h2>
                <p role="status">
                  {copy[snapshot.firstRecordedConfirmedIssuancesSeries.status]}
                </p>
              </section>
            )}
            <p>{copy.retainedEnrollmentSemantics}</p>
            {snapshot.retainedEnrollmentSeries.status === "available" ? (
              <>
                {metrics(copy.retainedEnrollmentOpening, {
                  openingRetainedAccounts:
                    snapshot.retainedEnrollmentSeries.openingRetainedAccounts,
                })}
                {table(
                  copy.retainedEnrollmentSeries,
                  snapshot.retainedEnrollmentSeries.rows,
                )}
              </>
            ) : (
              <section>
                <h2>{copy.retainedEnrollmentSeries}</h2>
                <p role="status">
                  {copy[snapshot.retainedEnrollmentSeries.status]}
                </p>
              </section>
            )}
            <p>{copy.recordedTierChangesSemantics}</p>
            {snapshot.recordedTierChangesSeries.status === "available" ? (
              table(
                copy.recordedTierChangesSeries,
                snapshot.recordedTierChangesSeries.rows,
              )
            ) : (
              <section>
                <h2>{copy.recordedTierChangesSeries}</h2>
                <p role="status">
                  {copy[snapshot.recordedTierChangesSeries.status]}
                </p>
              </section>
            )}
            <p>{copy.earningSourcesSemantics}</p>
            {table(copy.earningSources, snapshot.earningSources.rows)}
            <p>{copy.redemptionSourcesSemantics}</p>
            {table(copy.redemptionSources, [
              ...snapshot.redemptionSources.rows.map((row) => ({
                group: copy.recordedReward,
                rewardDefinitionId: row.rewardDefinitionId,
                capturedName: row.capturedName,
                rewardType: row.rewardType,
                redemptionEvents: row.eventCount,
                grossRedemptionPoints: row.pointsSpent,
              })),
              ...(snapshot.redemptionSources.other.eventCount !== "0"
                ? [
                    {
                      group: copy.otherRewards,
                      rewardDefinitionId: null,
                      capturedName: null,
                      rewardType: null,
                      redemptionEvents:
                        snapshot.redemptionSources.other.eventCount,
                      grossRedemptionPoints:
                        snapshot.redemptionSources.other.pointsSpent,
                    },
                  ]
                : []),
              ...(snapshot.redemptionSources.unknown.eventCount !== "0"
                ? [
                    {
                      group: copy.unknownReward,
                      rewardDefinitionId: null,
                      capturedName: null,
                      rewardType: null,
                      redemptionEvents:
                        snapshot.redemptionSources.unknown.eventCount,
                      grossRedemptionPoints:
                        snapshot.redemptionSources.unknown.pointsSpent,
                    },
                  ]
                : []),
            ])}
            {metrics(copy.redemptionSourcesTotal, {
              redemptionEvents: snapshot.redemptionSources.total.eventCount,
              grossRedemptionPoints:
                snapshot.redemptionSources.total.pointsSpent,
            })}
            <p>{copy.redemptionRateSemantics}</p>
            {snapshot.redemptionRateSeries.status === "available" ? (
              table(
                copy.redemptionRateSeries,
                snapshot.redemptionRateSeries.rows,
              )
            ) : (
              <section>
                <h2>{copy.redemptionRateSeries}</h2>
                <p role="status">
                  {copy[snapshot.redemptionRateSeries.status]}
                </p>
              </section>
            )}
            <section>
              <h2>{copy.rewardUsageRateTitle}</h2>
              <p role="status">{copy.rewardUsageRateUnavailable}</p>
            </section>
            <p>{copy.orderEarningSemantics}</p>
            {snapshot.orderEarningSeries.status === "available" ? (
              table(copy.orderEarningSeries, snapshot.orderEarningSeries.rows)
            ) : (
              <section>
                <h2>{copy.orderEarningSeries}</h2>
                <p role="status">{copy[snapshot.orderEarningSeries.status]}</p>
              </section>
            )}
            {metrics(copy.referralEconomics, snapshot.referralEconomics)}
            {table(copy.referrals, snapshot.referrals)}
            {table(copy.rewards, snapshot.rewards)}
            {table(
              copy.tiers,
              snapshot.tiers.map(({ assignment, ...tier }) => ({
                ...tier,
                name:
                  assignment === "configured" ? tier.name : label(assignment),
              })),
            )}
          </>
        )}
      </BlockStack>
    </article>
  );
}
