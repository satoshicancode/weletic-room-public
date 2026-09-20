export type ReviewAction = "open-prepare" | "open-upload" | "open-submit";
export type ReviewTransport = (
  action: ReviewAction,
  body: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export class AccountReviewError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "invalidInput"
      | "invalidPhotos"
      | "uncertain",
  ) {
    super(code);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AccountReviewError("unavailable");
  return value as Record<string, unknown>;
}

export function accountReviewProduct(url: string | null) {
  try {
    const values = new URL(url || "").searchParams.getAll("productId");
    return values.length === 1 &&
      /^gid:\/\/shopify\/Product\/[1-9][0-9]{0,19}$/.test(values[0])
      ? values[0]
      : null;
  } catch {
    return null;
  }
}

export async function prepareAccountReview(
  productId: string,
  transport: ReviewTransport,
) {
  if (!/^gid:\/\/shopify\/Product\/[1-9][0-9]{0,19}$/.test(productId))
    throw new AccountReviewError("unavailable");
  const result = object(await transport("open-prepare", { productId }));
  if (
    result.productId !== productId ||
    typeof result.productTitle !== "string" ||
    !result.productTitle.trim() ||
    result.productTitle.length > 512 ||
    typeof result.expectedInstallationGeneration !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(result.expectedInstallationGeneration) ||
    typeof result.expectedSettingsRevision !== "number" ||
    !Number.isInteger(result.expectedSettingsRevision) ||
    result.expectedSettingsRevision < 1 ||
    result.expectedSettingsRevision > 2147483647 ||
    result.disclosureRevision !== "open_unverified_unrewarded_v1" ||
    result.verifiedPurchase !== false ||
    result.incentivized !== false ||
    typeof result.photoUploadsAvailable !== "boolean" ||
    typeof result.authorBinding !== "string" ||
    !/^[a-f0-9]{64}$/.test(result.authorBinding)
  )
    throw new AccountReviewError("unavailable");
  return Object.freeze({
    productId,
    productTitle: result.productTitle,
    expectedInstallationGeneration: result.expectedInstallationGeneration,
    expectedSettingsRevision: result.expectedSettingsRevision,
    disclosureRevision: "open_unverified_unrewarded_v1" as const,
    authorBinding: result.authorBinding,
    photoUploadsAvailable: result.photoUploadsAvailable,
  });
}

export type AccountReviewPolicy = Awaited<
  ReturnType<typeof prepareAccountReview>
>;
export type AccountReviewDraft = {
  rating: number;
  displayName: string;
  title: string;
  body: string;
  publishConsent: boolean;
  locale: "en" | "ja" | "vi";
};
export type AccountReviewPhoto = { contentType: string; base64: string };

function boundedPhoto(photo: AccountReviewPhoto) {
  const encoded = photo.base64;
  if (
    !encoded ||
    encoded.length > 2796204 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    return false;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const size = (encoded.length / 4) * 3 - padding;
  return (
    size > 0 &&
    size <= 2 * 1024 * 1024 &&
    ["image/jpeg", "image/png", "image/webp"].includes(photo.contentType)
  );
}

/** Retain the exact operation in memory after uncertainty. Never cache shopper
 * authority or drafts in the DOM, URL, local storage or navigation history.
 */
export function accountReviewSubmission(
  policy: AccountReviewPolicy,
  draft: AccountReviewDraft,
  photos: readonly AccountReviewPhoto[],
  transport: ReviewTransport,
  uuid: () => string = () => crypto.randomUUID(),
) {
  const displayName = draft.displayName.trim();
  const title = draft.title.trim();
  const body = draft.body.trim();
  if (
    !Number.isInteger(draft.rating) ||
    draft.rating < 1 ||
    draft.rating > 5 ||
    !displayName ||
    displayName.length > 80 ||
    !title ||
    title.length > 120 ||
    body.length < 20 ||
    body.length > 10000 ||
    draft.publishConsent !== true ||
    !["en", "ja", "vi"].includes(draft.locale)
  )
    throw new AccountReviewError("invalidInput");
  if (
    photos.length > 5 ||
    (photos.length > 0 && !policy.photoUploadsAvailable) ||
    photos.some((photo) => !boundedPhoto(photo))
  )
    throw new AccountReviewError("invalidPhotos");
  const {
    photoUploadsAvailable: _available,
    productTitle: _title,
    ...authority
  } = policy;
  const submissionId = uuid();
  const content = Object.freeze({
    ...authority,
    submissionId,
    rating: draft.rating,
    displayName,
    title,
    body,
    publishConsent: true,
    locale: draft.locale,
  });
  const uploads = photos.map((photo) => ({
    id: null as string | null,
    payload: Object.freeze({
      productId: policy.productId,
      expectedInstallationGeneration: policy.expectedInstallationGeneration,
      expectedSettingsRevision: policy.expectedSettingsRevision,
      authorBinding: policy.authorBinding,
      submissionId,
      uploadId: uuid(),
      contentType: photo.contentType,
      base64: photo.base64,
    }),
  }));
  let running: Promise<void> | null = null;
  let completed = false;
  let uncertain = false;
  let submissionDispatched = false;
  async function dispatch() {
    try {
      for (const upload of uploads) {
        if (upload.id) continue;
        const receipt = object(await transport("open-upload", upload.payload));
        if (
          typeof receipt.id !== "string" ||
          receipt.id.length > 191 ||
          !/^wrevmedia_[A-Za-z0-9_-]+$/.test(receipt.id)
        )
          throw new AccountReviewError("uncertain");
        upload.id = receipt.id;
      }
      submissionDispatched = true;
      const result = object(
        await transport(
          "open-submit",
          Object.freeze({
            ...content,
            mediaIds: Object.freeze(uploads.map((upload) => upload.id)),
          }),
        ),
      );
      if (result.status !== "received" || typeof result.duplicate !== "boolean")
        throw new AccountReviewError("uncertain");
      completed = true;
    } catch (error) {
      if (
        error instanceof AccountReviewError &&
        ((error.code === "invalidInput" &&
          !uncertain &&
          uploads.length === 0) ||
          (error.code === "invalidPhotos" && !submissionDispatched))
      )
        throw error;
      uncertain = true;
      // A fresh token on retry does not authorize a different author: the
      // server validates the original immutable author binding and policy.
      throw new AccountReviewError("uncertain");
    }
  }
  return {
    send(): Promise<void> {
      if (completed) return Promise.resolve();
      if (running) return running;
      running = dispatch().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

/** Session tokens are obtained for each request; no automatic mutation retry. */
export function accountReviewTransport(
  endpoint: string,
  getToken: () => Promise<string>,
  request: typeof fetch = fetch,
): ReviewTransport {
  const base = new URL(endpoint);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new AccountReviewError("unavailable");
  return async (action, body) => {
    const response = await request(
      `${base.href.replace(/\/$/, "")}/${action}`,
      {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await getToken()}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.body) {
      throw new AccountReviewError("unavailable");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "",
      size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) throw new AccountReviewError("unavailable");
        text += decoder.decode(value, { stream: true });
      }
      const result = object(JSON.parse(text + decoder.decode()));
      if (!response.ok) {
        const error = result.error;
        const code =
          error && typeof error === "object" && "code" in error
            ? error.code
            : null;
        // Only the gateway's explicit pre-dispatch rejection can unlock text
        // editing; an arbitrary 400/401/403 is not proof of non-commit.
        if (
          response.status === 400 &&
          action === "open-submit" &&
          code === "invalid_review_input"
        )
          throw new AccountReviewError("invalidInput");
        if (
          response.status === 400 &&
          action === "open-upload" &&
          code === "invalid_open_photo"
        )
          throw new AccountReviewError("invalidPhotos");
        throw new AccountReviewError("unavailable");
      }
      return result;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
}
