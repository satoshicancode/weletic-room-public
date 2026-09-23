export class AccountStoreReviewError extends Error {
  constructor(readonly code: "unavailable" | "invalidInput" | "uncertain") {
    super(code);
  }
}

export type AccountStoreInvitation = {
  requestId: string;
  orderExternalId: string;
  fulfilledAt: string;
  expiresAt: string;
  incentiveDisclosure: Record<"en" | "ja" | "vi", string[]> | null;
};
export type AccountStoreInvitationPage = {
  items: AccountStoreInvitation[];
  nextCursor: string | null;
};
export type AccountStoreReviewTransport = {
  list(cursor?: string): Promise<AccountStoreInvitationPage>;
  submit(body: Readonly<Record<string, unknown>>): Promise<unknown>;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AccountStoreReviewError("unavailable");
  return value as Record<string, unknown>;
}
function invitation(value: unknown): AccountStoreInvitation {
  const row = record(value);
  const disclosure = row.incentiveDisclosure;
  if (
    typeof row.requestId !== "string" ||
    !/^wstorereq_[A-Za-z0-9_-]{1,191}$/.test(row.requestId) ||
    typeof row.orderExternalId !== "string" ||
    !row.orderExternalId ||
    row.orderExternalId.length > 191 ||
    typeof row.fulfilledAt !== "string" ||
    !Number.isFinite(Date.parse(row.fulfilledAt)) ||
    typeof row.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(row.expiresAt))
  )
    throw new AccountStoreReviewError("unavailable");
  if (disclosure !== null) {
    const text = record(disclosure);
    if (
      !(["en", "ja", "vi"] as const).every((language) => {
        const lines = text[language];
        return (
          Array.isArray(lines) &&
          lines.length <= 8 &&
          lines.every(
            (line: unknown) => typeof line === "string" && line.length <= 2000,
          )
        );
      })
    )
      throw new AccountStoreReviewError("unavailable");
  }
  return row as AccountStoreInvitation;
}
function page(value: unknown): AccountStoreInvitationPage {
  const result = record(value);
  if (
    !Array.isArray(result.items) ||
    result.items.length > 20 ||
    (result.nextCursor !== null &&
      (typeof result.nextCursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,191}$/.test(result.nextCursor)))
  )
    throw new AccountStoreReviewError("unavailable");
  return {
    items: result.items.map(invitation),
    nextCursor: result.nextCursor as string | null,
  };
}

/** Obtain a fresh Shopify session token for every request. No cached identity
 * or draft is persisted in URL, storage, or DOM attributes.
 */
export function accountStoreReviewTransport(
  endpoint: string,
  getToken: () => Promise<string>,
  request: typeof fetch = fetch,
): AccountStoreReviewTransport {
  const base = new URL(endpoint);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new AccountStoreReviewError("unavailable");
  const root = base.href.replace(/\/$/, "");
  async function dispatch(
    path: string,
    body?: Readonly<Record<string, unknown>>,
  ) {
    const response = await request(`${root}/${path}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.body) throw new AccountStoreReviewError("unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let content = "";
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 128 * 1024) throw new AccountStoreReviewError("unavailable");
        content += decoder.decode(value, { stream: true });
      }
      const result = record(JSON.parse(content + decoder.decode()));
      if (!response.ok) throw new AccountStoreReviewError("unavailable");
      return result;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  return {
    async list(cursor) {
      if (cursor && !/^[A-Za-z0-9_-]{1,191}$/.test(cursor))
        throw new AccountStoreReviewError("unavailable");
      return page(
        await dispatch(
          `store-invitations?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      );
    },
    submit(body) {
      return dispatch("store-submit", body);
    },
  };
}

export type AccountStoreReviewDraft = {
  rating: number;
  title: string;
  body: string;
  displayName: string;
  publishConsent: boolean;
  locale: "en" | "ja" | "vi";
};

/** A retry sends identical content against the same owned invitation. */
export function accountStoreReviewSubmission(
  invitation: AccountStoreInvitation,
  draft: AccountStoreReviewDraft,
  transport: AccountStoreReviewTransport,
) {
  const title = draft.title.trim();
  const body = draft.body.trim();
  const displayName = draft.displayName.trim();
  if (
    !Number.isInteger(draft.rating) ||
    draft.rating < 1 ||
    draft.rating > 5 ||
    title.length > 120 ||
    body.length < 1 ||
    body.length > 5000 ||
    !displayName ||
    displayName.length > 80 ||
    draft.publishConsent !== true ||
    !["en", "ja", "vi"].includes(draft.locale)
  )
    throw new AccountStoreReviewError("invalidInput");
  const payload = Object.freeze({
    requestId: invitation.requestId,
    rating: draft.rating,
    title,
    body,
    displayName,
    locale: draft.locale,
    publishConsent: true,
  });
  let running: Promise<void> | null = null;
  let completed = false;
  return {
    send(): Promise<void> {
      if (completed) return Promise.resolve();
      if (running) return running;
      running = transport
        .submit(payload)
        .then((result) => {
          const receipt = record(result);
          if (
            receipt.status !== "received" ||
            typeof receipt.duplicate !== "boolean"
          )
            throw new AccountStoreReviewError("uncertain");
          completed = true;
        })
        .catch(() => {
          throw new AccountStoreReviewError("uncertain");
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}
