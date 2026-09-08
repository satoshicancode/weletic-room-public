"use client";

import useWorkspace from "@/lib/swr/use-workspace";
import type { reviewSettingsSchema } from "@/lib/weletic/reviews/contracts";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import type { z } from "zod";

type Settings = z.infer<typeof reviewSettingsSchema>;
type Review = {
  id: string;
  version: number;
  createdAt: string;
  status: string;
  rating: number;
  title: string;
  body: string;
  displayName: string;
  merchantReply: string | null;
  verifiedPurchase: boolean;
  incentivized: boolean;
  rewardStatus: string;
  rewardReason: string | null;
  rewardPolicy?: "legacy" | "participation";
  canRetryReward?: boolean;
  product: { title: string };
  media: { id: string }[];
};
type Invitation = {
  id: string;
  createdAt: string;
  status: string;
  sendAt: string;
  expiresAt: string;
  deliveryAttempts: number;
  lastError: string | null;
  cancellationReason: string | null;
  product: { title: string };
};
type ResponseData = {
  items: (Review | Invitation)[];
  nextCursor: string | null;
  settings: Settings;
  shopDomain: string;
  canConfigure: boolean;
};
const control =
  "rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm disabled:opacity-50";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error?.message ?? "Unable to update reviews");
  return value;
}

export function ReviewsAdmin() {
  const { id: workspaceId, slug } = useWorkspace();
  const [view, setView] = useState("reviews");
  const [status, setStatus] = useState("");
  const [rating, setRating] = useState("");
  const [cursor, setCursor] = useState("");
  const [message, setMessage] = useState("");
  const endpoint = `/api/shopify/reviews/admin?workspaceId=${encodeURIComponent(workspaceId ?? "")}`;
  const key = workspaceId
    ? `${endpoint}&${new URLSearchParams({ view: view === "settings" ? "reviews" : view, status, ...(rating ? { rating } : {}), ...(cursor ? { cursor } : {}) })}`
    : null;
  const { data, error, isLoading, mutate } = useSWR<ResponseData>(
    key,
    requestJson,
    { revalidateOnFocus: false },
  );
  const save = async (body: unknown) => {
    setMessage("");
    try {
      await requestJson(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await mutate();
      setMessage("Saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save");
      throw error;
    }
  };
  const changeView = (value: string) => {
    setView(value);
    setStatus("");
    setRating("");
    setCursor("");
    setMessage("");
  };
  return (
    <div className="space-y-6 py-6">
      <div>
        <h2 className="text-xl font-semibold">Verified product reviews</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Collect honest feedback after fulfillment. All ratings receive the
          same reward eligibility.
        </p>
      </div>
      <nav className="flex flex-wrap gap-2" aria-label="Review sections">
        {["reviews", "requests", "settings"].map((tab) => (
          <button
            key={tab}
            className={control}
            aria-current={view === tab ? "page" : undefined}
            onClick={() => changeView(tab)}
          >
            {tab === "requests"
              ? "Review requests"
              : tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>
      <p role="status" className="text-sm">
        {message || (error instanceof Error ? error.message : "")}
      </p>
      {isLoading && <p>Loading reviews…</p>}
      {data && view === "settings" && (
        <ReviewSettingsForm
          key={JSON.stringify(data.settings)}
          settings={data.settings}
          canConfigure={data.canConfigure}
          save={save}
        />
      )}
      {data && view !== "settings" && (
        <>
          {!data.settings.enabled && (
            <p className="rounded-lg bg-amber-50 p-4 text-sm">
              Native reviews are disabled. Enable them in Settings when the
              connector and theme blocks are ready.
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <label>
              Status{" "}
              <select
                className={control}
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setCursor("");
                }}
              >
                <option value="">All</option>
                {(view === "reviews"
                  ? ["pending", "published", "hidden", "rejected", "redacted"]
                  : [
                      "queued",
                      "sending",
                      "sent",
                      "submitted",
                      "expired",
                      "cancelled",
                      "failed",
                    ]
                ).map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            {view === "reviews" && (
              <label>
                Rating{" "}
                <select
                  className={control}
                  value={rating}
                  onChange={(e) => {
                    setRating(e.target.value);
                    setCursor("");
                  }}
                >
                  <option value="">All ratings</option>
                  {[5, 4, 3, 2, 1].map((value) => (
                    <option key={value} value={value}>
                      {value} stars
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {!data.items.length && (
            <p className="rounded-lg border p-8 text-center text-neutral-600">
              No {view === "reviews" ? "reviews" : "requests"} match this
              filter.
            </p>
          )}
          <div className="space-y-4">
            {data.items.map((item) =>
              "rating" in item ? (
                <ReviewCard
                  key={`${item.id}:${item.version}`}
                  review={item}
                  endpoint={endpoint}
                  save={save}
                />
              ) : (
                <article
                  className="rounded-xl border bg-white p-5"
                  key={item.id}
                >
                  <h3 className="font-semibold">{item.product.title}</h3>
                  <p className="text-sm">
                    {item.status} · {item.deliveryAttempts} delivery attempts
                  </p>
                  <p className="text-sm text-neutral-600">
                    Scheduled: {new Date(item.sendAt).toLocaleString()} ·
                    Expires: {new Date(item.expiresAt).toLocaleString()}
                  </p>
                  {(item.lastError || item.cancellationReason) && (
                    <p className="text-sm">
                      {item.lastError || item.cancellationReason}
                    </p>
                  )}
                </article>
              ),
            )}
          </div>
          <div className="flex gap-3">
            {cursor && (
              <button className={control} onClick={() => setCursor("")}>
                First page
              </button>
            )}
            {data.nextCursor && (
              <button
                className={control}
                onClick={() => setCursor(data.nextCursor ?? "")}
              >
                Next page
              </button>
            )}
          </div>
        </>
      )}
      <p className="text-sm text-neutral-600">
        Configure review points in{" "}
        <Link className="underline" href={`/${slug}/loyalty/earn`}>
          Ways to Earn
        </Link>
        . Video, imports, and open submissions are not included. New Judge.me
        connections are disabled.
      </p>
    </div>
  );
}

function ReviewCard({
  review,
  endpoint,
  save,
}: {
  review: Review;
  endpoint: string;
  save: (data: unknown) => Promise<void>;
}) {
  const [reply, setReply] = useState(review.merchantReply ?? "");
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [photoError, setPhotoError] = useState("");
  const moderate = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await save({
        action: "moderate",
        reviewId: review.id,
        patch: { version: review.version, ...patch },
      });
    } catch {
      /* Parent displays the sanitized error. */
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="space-y-3 rounded-xl border bg-white p-5">
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-semibold">{review.title || "Redacted review"}</h3>
        <span className="text-sm">
          {review.status} · {review.rating}/5
        </span>
      </div>
      <p className="text-sm text-neutral-600">
        {review.product.title} · {review.displayName} ·{" "}
        {new Date(review.createdAt).toLocaleDateString()}
        {review.verifiedPurchase ? " · Verified purchase" : ""}
        {review.incentivized ? " · Incentivized review" : ""}
      </p>
      <p className="whitespace-pre-wrap break-words">{review.body}</p>
      <p className="text-sm">
        Reward: {review.rewardStatus}
        {review.rewardReason === "active_reviews_and_loyalty_account_required"
          ? " (Waiting for active reviews, loyalty program, and shopper enrollment.)"
          : review.rewardReason
            ? ` (${review.rewardReason})`
            : ""}
      </p>
      {!!review.media.length && (
        <button
          className={control}
          onClick={async () => {
            try {
              const urls = await Promise.all(
                review.media.map((media) =>
                  requestJson<{ url: string }>(
                    `${endpoint}&mediaId=${encodeURIComponent(media.id)}`,
                  ),
                ),
              );
              setPhotos(urls.map((row) => row.url));
            } catch {
              setPhotoError("Photos could not be loaded. Try again.");
            }
          }}
        >
          View {review.media.length} photos
        </button>
      )}
      {photoError && <p role="status">{photoError}</p>}
      <div className="flex flex-wrap gap-2">
        {photos.map((url, index) => (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className={control}
            key={index}
          >
            Open photo {index + 1}
          </a>
        ))}
      </div>
      {review.status !== "redacted" && (
        <fieldset disabled={busy} className="space-y-3">
          <label className="block text-sm">
            Public merchant reply
            <textarea
              className={`${control} mt-1 block min-h-20 w-full`}
              value={reply}
              maxLength={5000}
              onChange={(e) => setReply(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className={control}
              onClick={() => moderate({ merchantReply: reply || null })}
            >
              Save reply
            </button>
            {["published", "hidden", "rejected"].map((status) => (
              <button
                className={control}
                key={status}
                disabled={review.status === status}
                onClick={() => moderate({ status })}
              >
                {status === "published"
                  ? "Publish"
                  : status === "hidden"
                    ? "Hide"
                    : "Reject"}
              </button>
            ))}
            {review.canRetryReward && (
              <button
                className={control}
                onClick={() => moderate({ retryReward: true })}
              >
                Retry eligible reward
              </button>
            )}
          </div>
          <small className="text-neutral-500">
            {review.rewardPolicy === "participation"
              ? "Participation rewards do not depend on publication. Hiding or rejecting feedback does not revoke its reward; confirmed invalidity uses the separate recovery process."
              : review.rewardPolicy === "legacy"
                ? "This historical review uses its original publication-based reward policy. Hiding or rejecting reverses awarded points once; republishing does not issue another reward."
                : "Reload to view this review's reward policy and available retry actions."}
          </small>
        </fieldset>
      )}
    </article>
  );
}

function ReviewSettingsForm({
  settings,
  canConfigure,
  save,
}: {
  settings: Settings;
  canConfigure: boolean;
  save: (data: unknown) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await save({
            action: "settings",
            settings: {
              enabled: draft.enabled,
              requestEmailEnabled: draft.requestEmailEnabled,
              autoPublish: draft.autoPublish,
              photoUploadsEnabled: draft.photoUploadsEnabled,
              sendAfterDays: draft.sendAfterDays,
              expiresAfterDays: draft.expiresAfterDays,
            },
          });
        } catch {
          /* Parent displays the error. */
        } finally {
          setBusy(false);
        }
      }}
      className="max-w-2xl space-y-5 rounded-xl border p-6"
    >
      <p className="text-sm">
        Enabling native reviews disables the legacy Judge.me connection.
        Existing review and ledger history is retained. Only new fulfillment
        events after activation generate requests.
      </p>
      {!canConfigure && <p>Only workspace owners can change these settings.</p>}
      <fieldset disabled={!canConfigure || busy} className="space-y-4">
        {(
          [
            ["enabled", "Enable native reviews"],
            [
              "requestEmailEnabled",
              "Send review invitations after fulfillment",
            ],
            ["autoPublish", "Publish verified reviews automatically"],
            ["photoUploadsEnabled", "Allow photos (requires private storage)"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex gap-2">
            <input
              type="checkbox"
              checked={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
        <label className="block">
          Days after fulfillment
          <input
            className={`${control} ml-3 w-24`}
            type="number"
            min={0}
            max={60}
            required
            value={draft.sendAfterDays}
            onChange={(e) =>
              setDraft({ ...draft, sendAfterDays: Number(e.target.value) })
            }
          />
        </label>
        <label className="block">
          Invitation valid for (days)
          <input
            className={`${control} ml-3 w-24`}
            type="number"
            min={1}
            max={90}
            required
            value={draft.expiresAfterDays}
            onChange={(e) =>
              setDraft({ ...draft, expiresAfterDays: Number(e.target.value) })
            }
          />
        </label>
        <button className={control} type="submit">
          {busy ? "Saving…" : "Save settings"}
        </button>
      </fieldset>
    </form>
  );
}
