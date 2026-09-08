import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { createHash } from "node:crypto";
import {
  deserializeShopifySession,
  serializeShopifySession,
} from "./session-properties.server";
import { weleticApiJson } from "./weletic-api.server";

type SessionProperty = [string, string | number | boolean];

interface SessionResponse {
  sessions: Array<{
    properties: SessionProperty[];
    onlineBinding?: unknown;
    onlineDigest?: unknown;
  }>;
}

const SHOPIFY_ACCESS_SCOPE_API_VERSION = "2026-07";
const CURRENT_APP_INSTALLATION_SCOPES_QUERY = `
  query WeleticCurrentAppInstallationScopes {
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

function replaceSessionScope(
  properties: SessionProperty[],
  scope: string,
): SessionProperty[] {
  const next = properties.filter(([key]) => key !== "scope");
  next.push(["scope", scope]);
  return next;
}

export async function fetchCurrentAppInstallationScopes({
  shop,
  accessToken,
  customFetch = fetch,
}: {
  shop: string;
  accessToken: string;
  customFetch?: typeof fetch;
}) {
  const canonicalShop = shop.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(canonicalShop)) {
    throw new Error("Shopify session contains an invalid shop domain.");
  }

  const response = await customFetch(
    `https://${canonicalShop}/admin/api/${SHOPIFY_ACCESS_SCOPE_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query: CURRENT_APP_INSTALLATION_SCOPES_QUERY }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Shopify access-scope reconciliation failed with HTTP ${response.status}.`,
    );
  }

  const payload = (await response.json()) as {
    data?: {
      currentAppInstallation?: {
        accessScopes?: Array<{ handle?: unknown }>;
      } | null;
    };
    errors?: Array<{ message?: unknown }>;
  };
  if (payload.errors?.length) {
    throw new Error("Shopify access-scope reconciliation returned errors.");
  }

  const scopes = Array.from(
    new Set(
      (payload.data?.currentAppInstallation?.accessScopes || [])
        .map(({ handle }) => (typeof handle === "string" ? handle.trim() : ""))
        .filter(Boolean),
    ),
  ).sort();
  if (scopes.length === 0) {
    throw new Error("Shopify returned no authoritative access scopes.");
  }
  return scopes;
}

export class WeleticSessionStorage implements SessionStorage {
  async storeSession(session: Session) {
    const previousSession =
      !session.isOnline && session.accessToken
        ? await this.loadSession(session.id)
        : undefined;
    const expectedCredentialTokenHash = previousSession?.accessToken
      ? createHash("sha256").update(previousSession.accessToken).digest("hex")
      : null;
    let properties = serializeShopifySession(session);
    if (!session.isOnline && session.shop && session.accessToken) {
      try {
        const scopes = await fetchCurrentAppInstallationScopes({
          shop: session.shop,
          accessToken: session.accessToken,
        });
        properties = replaceSessionScope(properties, scopes.join(","));
      } catch {
        // Persisting the refreshable token remains more important than a scope
        // metadata refresh. Financial operations still fail closed when their
        // cached scope proof is absent.
      }
    }
    await weleticApiJson<{ stored: true }>("/api/internal/shopify/sessions", {
      method: "POST",
      body: JSON.stringify({
        properties,
        expectedCredentialTokenHash,
      }),
    });
    return true;
  }

  async loadSession(id: string) {
    const stored = await this.loadStoredSession(id);
    return stored ? deserializeShopifySession(stored.properties) : undefined;
  }

  protected async loadStoredSession(id: string) {
    const response = await weleticApiJson<SessionResponse>(
      `/api/internal/shopify/sessions?id=${encodeURIComponent(id)}`,
    );
    return response.sessions[0];
  }

  async deleteSession(id: string) {
    return this.deleteSessions([id]);
  }

  async deleteSessions(ids: string[]) {
    await weleticApiJson<{ deleted: number }>(
      "/api/internal/shopify/sessions",
      {
        method: "DELETE",
        body: JSON.stringify({ ids }),
      },
    );
    return true;
  }

  async findSessionsByShop(shop: string) {
    const response = await weleticApiJson<SessionResponse>(
      `/api/internal/shopify/sessions?shop=${encodeURIComponent(shop)}`,
    );
    return response.sessions
      .map(({ properties }) => deserializeShopifySession(properties))
      .filter((session): session is Session => session !== undefined);
  }
}
