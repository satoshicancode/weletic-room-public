/**
 * Cloudflare Workers Analytics Engine SQL Client
 * Replaces Tinybird pipes with zero-egress native edge SQL querying
 */

export const ANALYTICS_ENGINE_DATASET = "clicks_analytics";
export const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

export interface AnalyticsEngineConfig {
  accountId?: string;
  apiToken?: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
}

export interface AnalyticsEngineColumnMeta {
  name: string;
  type: string;
}

export interface AnalyticsEngineResponse<T = Record<string, unknown>> {
  data: T[];
  meta: AnalyticsEngineColumnMeta[];
  rows: number;
  rows_before_limit_at_least?: number;
}

export interface PartnerTimeseriesQueryOptions {
  projectId: string;
  partnerId?: string;
  startDate: Date | string;
  endDate: Date | string;
  intervalDays?: number;
}

export interface PartnerClicksTimeseriesRow {
  partnerId: string;
  day: string;
  totalClicks: number;
  validClicks: number;
  botClicks: number;
  totalConversionValue: number;
}

export interface GeoDistributionQueryOptions {
  projectId: string;
  partnerId?: string;
  linkId?: string;
  startDate?: Date | string;
  endDate?: Date | string;
  limit?: number;
}

export interface GeoDistributionRow {
  country: string;
  totalClicks: number;
  validClicks: number;
}

export interface LinkAnalyticsQueryOptions {
  projectId: string;
  linkId?: string;
  key?: string;
  startDate?: Date | string;
  endDate?: Date | string;
}

export interface LinkAnalyticsRow {
  linkId: string;
  key: string;
  totalClicks: number;
  validClicks: number;
  qrClicks: number;
  totalConversionValue: number;
}

export interface DailyWorkspaceAggregationsOptions {
  projectId: string;
  days?: number;
  startDate?: Date | string;
  endDate?: Date | string;
}

export interface DailyWorkspaceAggregationRow {
  day: string;
  totalClicks: number;
  validClicks: number;
  botClicks: number;
  qrClicks: number;
  totalConversionValue: number;
}

/**
 * Escapes strings for safe inclusion in Cloudflare Analytics Engine SQL queries.
 */
export function escapeSqlString(value: string): string {
  if (typeof value !== "string") {
    return String(value);
  }
  // ClickHouse / SQL string escape: escape single quotes and backslashes
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

/**
 * Formats a Date or timestamp string into ClickHouse-compatible format: YYYY-MM-DD HH:MM:SS
 */
export function formatSqlDate(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date provided to formatSqlDate: ${String(date)}`);
  }
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  const seconds = String(d.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Builds SQL query for partner daily click timeseries and conversions
 */
export function buildPartnerClicksTimeseriesQuery(
  options: PartnerTimeseriesQueryOptions,
): string {
  const {
    projectId,
    partnerId,
    startDate,
    endDate,
    intervalDays = 1,
  } = options;

  const conditions: string[] = [
    `index1 = '${escapeSqlString(projectId)}'`,
    `timestamp >= toDateTime('${formatSqlDate(startDate)}')`,
    `timestamp <= toDateTime('${formatSqlDate(endDate)}')`,
  ];

  if (partnerId) {
    conditions.push(`blob5 = '${escapeSqlString(partnerId)}'`);
  }

  const intervalClause = `INTERVAL '${intervalDays}' DAY`;

  return [
    "SELECT",
    "  blob5 AS partnerId,",
    `  toStartOfInterval(timestamp, ${intervalClause}) AS day,`,
    "  count() AS totalClicks,",
    "  countIf(double1 = 0) AS validClicks,",
    "  countIf(double1 = 1) AS botClicks,",
    "  sum(double3) AS totalConversionValue",
    `FROM ${ANALYTICS_ENGINE_DATASET}`,
    `WHERE ${conditions.join(" AND ")}`,
    "GROUP BY partnerId, day",
    "ORDER BY day ASC",
  ].join("\n");
}

/**
 * Builds SQL query for geographic country click distribution
 */
export function buildGeoDistributionQuery(
  options: GeoDistributionQueryOptions,
): string {
  const {
    projectId,
    partnerId,
    linkId,
    startDate,
    endDate,
    limit = 50,
  } = options;

  const conditions: string[] = [`index1 = '${escapeSqlString(projectId)}'`];

  if (partnerId) {
    conditions.push(`blob5 = '${escapeSqlString(partnerId)}'`);
  }
  if (linkId) {
    conditions.push(`blob3 = '${escapeSqlString(linkId)}'`);
  }
  if (startDate) {
    conditions.push(`timestamp >= toDateTime('${formatSqlDate(startDate)}')`);
  }
  if (endDate) {
    conditions.push(`timestamp <= toDateTime('${formatSqlDate(endDate)}')`);
  }

  return [
    "SELECT",
    "  blob6 AS country,",
    "  count() AS totalClicks,",
    "  countIf(double1 = 0) AS validClicks",
    `FROM ${ANALYTICS_ENGINE_DATASET}`,
    `WHERE ${conditions.join(" AND ")}`,
    "GROUP BY country",
    "ORDER BY totalClicks DESC",
    `LIMIT ${Math.max(1, Math.min(1000, limit))}`,
  ].join("\n");
}

/**
 * Builds SQL query for link-level click aggregation
 */
export function buildLinkAnalyticsQuery(
  options: LinkAnalyticsQueryOptions,
): string {
  const { projectId, linkId, key, startDate, endDate } = options;

  const conditions: string[] = [`index1 = '${escapeSqlString(projectId)}'`];

  if (linkId) {
    conditions.push(`blob3 = '${escapeSqlString(linkId)}'`);
  }
  if (key) {
    conditions.push(`blob2 = '${escapeSqlString(key)}'`);
  }
  if (startDate) {
    conditions.push(`timestamp >= toDateTime('${formatSqlDate(startDate)}')`);
  }
  if (endDate) {
    conditions.push(`timestamp <= toDateTime('${formatSqlDate(endDate)}')`);
  }

  return [
    "SELECT",
    "  blob3 AS linkId,",
    "  blob2 AS key,",
    "  count() AS totalClicks,",
    "  countIf(double1 = 0) AS validClicks,",
    "  countIf(double2 = 1) AS qrClicks,",
    "  sum(double3) AS totalConversionValue",
    `FROM ${ANALYTICS_ENGINE_DATASET}`,
    `WHERE ${conditions.join(" AND ")}`,
    "GROUP BY linkId, key",
  ].join("\n");
}

/**
 * Builds SQL query for workspace daily aggregates
 */
export function buildDailyWorkspaceAggregationsQuery(
  options: DailyWorkspaceAggregationsOptions,
): string {
  const { projectId, days = 30, startDate, endDate } = options;

  const conditions: string[] = [`index1 = '${escapeSqlString(projectId)}'`];

  if (startDate && endDate) {
    conditions.push(`timestamp >= toDateTime('${formatSqlDate(startDate)}')`);
    conditions.push(`timestamp <= toDateTime('${formatSqlDate(endDate)}')`);
  } else {
    conditions.push(`timestamp >= NOW() - INTERVAL '${days}' DAY`);
  }

  return [
    "SELECT",
    "  toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,",
    "  count() AS totalClicks,",
    "  countIf(double1 = 0) AS validClicks,",
    "  countIf(double1 = 1) AS botClicks,",
    "  countIf(double2 = 1) AS qrClicks,",
    "  sum(double3) AS totalConversionValue",
    `FROM ${ANALYTICS_ENGINE_DATASET}`,
    `WHERE ${conditions.join(" AND ")}`,
    "GROUP BY day",
    "ORDER BY day DESC",
  ].join("\n");
}

export class AnalyticsEngineError extends Error {
  public status: number;
  public details?: unknown;

  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.name = "AnalyticsEngineError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Executes a raw SQL query against Cloudflare Analytics Engine SQL API
 */
export async function executeAnalyticsEngineQuery<T = Record<string, unknown>>(
  sqlQuery: string,
  config?: AnalyticsEngineConfig,
): Promise<AnalyticsEngineResponse<T>> {
  const accountId =
    config?.accountId ||
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    process.env.CF_ACCOUNT_ID;

  const apiToken =
    config?.apiToken ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.CF_ANALYTICS_API_TOKEN ||
    process.env.CF_API_TOKEN;

  if (!accountId) {
    throw new AnalyticsEngineError(
      "Missing Cloudflare Account ID for Analytics Engine SQL API",
      400,
    );
  }

  if (!apiToken) {
    throw new AnalyticsEngineError(
      "Missing Cloudflare API Token for Analytics Engine SQL API",
      401,
    );
  }

  const endpoint =
    config?.endpoint ||
    `${CLOUDFLARE_API_BASE_URL}/accounts/${accountId}/analytics_engine/sql`;

  const fetcher = config?.fetchFn || fetch;

  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "text/plain",
    },
    body: sqlQuery,
  });

  if (!response.ok) {
    let errorDetails: unknown = null;
    try {
      errorDetails = await response.json();
    } catch {
      errorDetails = await response.text();
    }
    throw new AnalyticsEngineError(
      `Analytics Engine SQL query failed with status ${response.status}`,
      response.status,
      errorDetails,
    );
  }

  const jsonResult = (await response.json()) as AnalyticsEngineResponse<T>;
  return {
    data: jsonResult.data || [],
    meta: jsonResult.meta || [],
    rows:
      typeof jsonResult.rows === "number"
        ? jsonResult.rows
        : jsonResult.data?.length || 0,
    rows_before_limit_at_least: jsonResult.rows_before_limit_at_least,
  };
}

/**
 * High-level helper: Fetch partner timeseries stats via Analytics Engine SQL API
 */
export async function fetchPartnerClicksTimeseries(
  options: PartnerTimeseriesQueryOptions,
  config?: AnalyticsEngineConfig,
): Promise<PartnerClicksTimeseriesRow[]> {
  const query = buildPartnerClicksTimeseriesQuery(options);
  const result = await executeAnalyticsEngineQuery<PartnerClicksTimeseriesRow>(
    query,
    config,
  );
  return result.data;
}

/**
 * High-level helper: Fetch geo distribution via Analytics Engine SQL API
 */
export async function fetchGeoDistribution(
  options: GeoDistributionQueryOptions,
  config?: AnalyticsEngineConfig,
): Promise<GeoDistributionRow[]> {
  const query = buildGeoDistributionQuery(options);
  const result = await executeAnalyticsEngineQuery<GeoDistributionRow>(
    query,
    config,
  );
  return result.data;
}

/**
 * High-level helper: Fetch link analytics via Analytics Engine SQL API
 */
export async function fetchLinkAnalytics(
  options: LinkAnalyticsQueryOptions,
  config?: AnalyticsEngineConfig,
): Promise<LinkAnalyticsRow[]> {
  const query = buildLinkAnalyticsQuery(options);
  const result = await executeAnalyticsEngineQuery<LinkAnalyticsRow>(
    query,
    config,
  );
  return result.data;
}

/**
 * High-level helper: Fetch daily workspace aggregations via Analytics Engine SQL API
 */
export async function fetchDailyWorkspaceAggregations(
  options: DailyWorkspaceAggregationsOptions,
  config?: AnalyticsEngineConfig,
): Promise<DailyWorkspaceAggregationRow[]> {
  const query = buildDailyWorkspaceAggregationsQuery(options);
  const result =
    await executeAnalyticsEngineQuery<DailyWorkspaceAggregationRow>(
      query,
      config,
    );
  return result.data;
}
