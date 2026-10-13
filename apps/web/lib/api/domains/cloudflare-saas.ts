/**
 * Cloudflare for SaaS (Custom Hostnames) Client
 *
 * Provides automated SSL provisioning and management for up to 100 free partner custom domains
 * per zone via Cloudflare for SaaS (Custom Hostnames API).
 *
 * Implements R5 (Milestone 5) and complies with:
 * - Invariant 4: Zero hardcoding of store domains, workspace IDs, or tenant credentials.
 */

export interface CloudflareSaaSConfig {
  zoneId: string;
  apiToken: string;
  baseUrl?: string;
}

export interface AddCustomHostnameOptions {
  customOriginServer?: string;
  sslMethod?: "http" | "txt" | "email" | "cname";
  sslType?: "dv";
  minTlsVersion?: string;
  wildcard?: boolean;
}

export interface CloudflareSslValidationRecord {
  status?: string;
  txt_name?: string;
  txt_value?: string;
  http_url?: string;
  http_body?: string;
  cname_target?: string;
  cname?: string;
}

export interface CloudflareSslDetails {
  id?: string;
  type?: string;
  method?: string;
  status: string;
  validation_records?: CloudflareSslValidationRecord[];
  validation_errors?: Array<{ message: string }>;
  settings?: {
    min_tls_version?: string;
  };
}

export interface CloudflareOwnershipVerification {
  type: string;
  name: string;
  value: string;
}

export interface CloudflareCustomHostnameResult {
  id: string;
  hostname: string;
  status: string;
  ssl: CloudflareSslDetails;
  custom_origin_server?: string;
  ownership_verification?: CloudflareOwnershipVerification;
  created_at?: string;
}

export interface DnsVerificationRecord {
  type: "TXT" | "CNAME" | "HTTP";
  name: string;
  value: string;
  status?: string;
}

export class CloudflareSaaSError extends Error {
  public readonly errors: unknown[];
  public readonly statusCode?: number;

  constructor(message: string, errors: unknown[] = [], statusCode?: number) {
    super(message);
    this.name = "CloudflareSaaSError";
    this.errors = errors;
    this.statusCode = statusCode;
  }
}

/**
 * Returns whether Cloudflare credentials are configured in the current environment.
 */
export function isCloudflareSaaSConfigured(): boolean {
  return Boolean(
    process.env.CLOUDFLARE_ZONE_ID && process.env.CLOUDFLARE_API_TOKEN,
  );
}

/**
 * Resolves Cloudflare for SaaS configuration from environment variables.
 */
export function getCloudflareSaaSConfig(): CloudflareSaaSConfig | null {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();

  if (!zoneId || !apiToken) {
    return null;
  }

  return {
    zoneId,
    apiToken,
    baseUrl: "https://api.cloudflare.com/client/v4",
  };
}

function generateDevFallbackCustomHostname(
  domain: string,
  options?: AddCustomHostnameOptions,
): CloudflareCustomHostnameResult {
  const normalizedDomain = domain.toLowerCase().trim();
  const sanitized = normalizedDomain.replace(/[^a-zA-Z0-9]/g, "_");

  return {
    id: `cf_dev_${sanitized}`,
    hostname: normalizedDomain,
    status: "active",
    ssl: {
      id: `ssl_dev_${sanitized}`,
      type: options?.sslType ?? "dv",
      method: options?.sslMethod ?? "http",
      status: "active",
      validation_records: [
        {
          status: "active",
          txt_name: `_cf-custom-hostname.${normalizedDomain}`,
          txt_value: `cf-dev-verification-${sanitized}`,
        },
      ],
      settings: {
        min_tls_version: options?.minTlsVersion ?? "1.2",
      },
    },
    ownership_verification: {
      type: "txt",
      name: `_cf-custom-hostname.${normalizedDomain}`,
      value: `cf-dev-verification-${sanitized}`,
    },
    custom_origin_server: options?.customOriginServer,
    created_at: new Date().toISOString(),
  };
}

/**
 * Adds a partner custom hostname to Cloudflare for SaaS with automated SSL.
 */
export async function addCustomHostnameToCloudflare(
  domain: string,
  options: AddCustomHostnameOptions = {},
): Promise<CloudflareCustomHostnameResult> {
  const normalizedDomain = domain.toLowerCase().trim();
  if (!normalizedDomain) {
    throw new Error("Domain name must not be empty");
  }

  const config = getCloudflareSaaSConfig();
  if (!config) {
    if (process.env.NODE_ENV === "production") {
      throw new CloudflareSaaSError(
        "Cloudflare for SaaS requires CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN",
      );
    }
    return generateDevFallbackCustomHostname(normalizedDomain, options);
  }

  const payload = {
    hostname: normalizedDomain,
    ssl: {
      method: options.sslMethod ?? "http",
      type: options.sslType ?? "dv",
      settings: {
        min_tls_version: options.minTlsVersion ?? "1.2",
      },
      wildcard: options.wildcard ?? false,
    },
    ...(options.customOriginServer && {
      custom_origin_server: options.customOriginServer,
    }),
  };

  const response = await fetch(
    `${config.baseUrl}/zones/${config.zoneId}/custom_hostnames`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  const data = (await response.json()) as {
    success: boolean;
    errors?: unknown[];
    result?: CloudflareCustomHostnameResult;
  };

  if (!data.success || !data.result) {
    const errorDetails = data.errors?.length
      ? JSON.stringify(data.errors)
      : response.statusText;
    throw new CloudflareSaaSError(
      `Failed to create custom hostname "${normalizedDomain}": ${errorDetails}`,
      data.errors ?? [],
      response.status,
    );
  }

  return data.result;
}

/**
 * Retrieves a custom hostname from Cloudflare for SaaS by hostname or ID.
 */
export async function getCustomHostnameFromCloudflare(
  hostnameOrId: string,
): Promise<CloudflareCustomHostnameResult | null> {
  const query = hostnameOrId.trim();
  if (!query) {
    throw new Error("hostnameOrId must not be empty");
  }

  const config = getCloudflareSaaSConfig();
  if (!config) {
    if (process.env.NODE_ENV === "production") {
      throw new CloudflareSaaSError(
        "Cloudflare for SaaS requires CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN",
      );
    }
    return generateDevFallbackCustomHostname(query);
  }

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      query,
    );

  const endpoint = isUuid
    ? `${config.baseUrl}/zones/${config.zoneId}/custom_hostnames/${query}`
    : `${config.baseUrl}/zones/${config.zoneId}/custom_hostnames?hostname=${encodeURIComponent(query.toLowerCase())}`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
  });

  const data = (await response.json()) as {
    success: boolean;
    errors?: unknown[];
    result?: CloudflareCustomHostnameResult | CloudflareCustomHostnameResult[];
  };

  if (!data.success) {
    if (response.status === 404) {
      return null;
    }
    throw new CloudflareSaaSError(
      `Failed to fetch custom hostname "${query}": ${JSON.stringify(data.errors)}`,
      data.errors ?? [],
      response.status,
    );
  }

  if (Array.isArray(data.result)) {
    return data.result[0] ?? null;
  }

  return data.result ?? null;
}

/**
 * Deletes a custom hostname from Cloudflare for SaaS by hostname or ID.
 */
export async function deleteCustomHostnameFromCloudflare(
  hostnameOrId: string,
): Promise<{ id: string; deleted: boolean }> {
  const query = hostnameOrId.trim();
  if (!query) {
    throw new Error("hostnameOrId must not be empty");
  }

  const config = getCloudflareSaaSConfig();
  if (!config) {
    if (process.env.NODE_ENV === "production") {
      throw new CloudflareSaaSError(
        "Cloudflare for SaaS requires CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN",
      );
    }
    return { id: query, deleted: true };
  }

  let targetId = query;
  if (query.includes(".")) {
    const existing = await getCustomHostnameFromCloudflare(query);
    if (!existing) {
      return { id: query, deleted: false };
    }
    targetId = existing.id;
  }

  const response = await fetch(
    `${config.baseUrl}/zones/${config.zoneId}/custom_hostnames/${targetId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
    },
  );

  const data = (await response.json()) as {
    success: boolean;
    errors?: unknown[];
    result?: { id: string };
  };

  if (!data.success) {
    throw new CloudflareSaaSError(
      `Failed to delete custom hostname "${targetId}": ${JSON.stringify(data.errors)}`,
      data.errors ?? [],
      response.status,
    );
  }

  return { id: targetId, deleted: true };
}

/**
 * Extracts and normalizes DNS and HTTP validation records from a custom hostname record.
 */
export function extractSslValidationRecords(
  customHostname: CloudflareCustomHostnameResult,
): DnsVerificationRecord[] {
  const records: DnsVerificationRecord[] = [];
  const seen = new Set<string>();

  const addRecord = (record: DnsVerificationRecord) => {
    const key = `${record.type}:${record.name}:${record.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      records.push(record);
    }
  };

  // 1. SSL validation records (TXT, CNAME, HTTP)
  if (Array.isArray(customHostname.ssl?.validation_records)) {
    for (const record of customHostname.ssl.validation_records) {
      if (record.txt_name && record.txt_value) {
        addRecord({
          type: "TXT",
          name: record.txt_name,
          value: record.txt_value,
          status: record.status,
        });
      }
      if (record.cname && record.cname_target) {
        addRecord({
          type: "CNAME",
          name: record.cname,
          value: record.cname_target,
          status: record.status,
        });
      }
      if (record.http_url && record.http_body) {
        addRecord({
          type: "HTTP",
          name: record.http_url,
          value: record.http_body,
          status: record.status,
        });
      }
    }
  }

  // 2. Ownership verification record (typically TXT)
  if (customHostname.ownership_verification) {
    const ov = customHostname.ownership_verification;
    addRecord({
      type: "TXT",
      name: ov.name,
      value: ov.value,
      status: customHostname.status,
    });
  }

  return records;
}

/**
 * Convenience helper to verify custom hostname status and retrieve its active DNS verification requirements.
 */
export async function verifyCustomHostname(hostnameOrId: string): Promise<{
  verified: boolean;
  status: string;
  sslStatus: string;
  validationRecords: DnsVerificationRecord[];
}> {
  const hostname = await getCustomHostnameFromCloudflare(hostnameOrId);
  if (!hostname) {
    return {
      verified: false,
      status: "not_found",
      sslStatus: "not_found",
      validationRecords: [],
    };
  }

  const isVerified =
    hostname.status === "active" && hostname.ssl.status === "active";
  const validationRecords = extractSslValidationRecords(hostname);

  return {
    verified: isVerified,
    status: hostname.status,
    sslStatus: hostname.ssl.status,
    validationRecords,
  };
}
