(() => {
  if (customElements.get("weletic-reviews")) return;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  class WeleticReviews extends HTMLElement {
    connectedCallback() {
      if (this.initialized) {
        this.load(true);
        return;
      }
      this.initialized = true;
      this.generation = 0;
      this.cursor = null;
      this.replaceChildren();
      this.summary = element("p", "", "wr-summary");
      this.status = element("p", "Loading reviews…");
      this.status.setAttribute("role", "status");
      this.status.setAttribute("aria-live", "polite");
      this.append(this.summary, this.status);
      if (this.dataset.mode === "full") {
        this.prepend(element("h2", "Customer reviews"));
        const filters = element("div", undefined, "wr-filters");
        this.sort = this.select(
          "Sort reviews",
          [
            ["newest", "Newest"],
            ["highest", "Highest rating"],
            ["lowest", "Lowest rating"],
          ],
          filters,
        );
        this.rating = this.select(
          "Filter by rating",
          [
            ["", "All ratings"],
            ...[5, 4, 3, 2, 1].map((n) => [
              String(n),
              `${n} ${n === 1 ? "star" : "stars"}`,
            ]),
          ],
          filters,
        );
        this.rows = element("div");
        this.more = element("button", "Load more reviews");
        this.more.type = "button";
        this.more.hidden = true;
        this.more.addEventListener("click", () => this.load(false));
        this.append(filters, this.rows, this.more);
        this.append(
          element(
            "p",
            "Review invitations are sent to verified purchasers after fulfillment. All ratings are welcome; any loyalty reward is independent of rating.",
            "wr-meta",
          ),
        );
      }
      this.load(true);
    }
    disconnectedCallback() {
      this.generation += 1;
    }
    select(labelText, choices, parent) {
      const label = element("label", `${labelText} `);
      const select = element("select");
      for (const [value, text] of choices) {
        const option = element("option", text);
        option.value = value;
        select.append(option);
      }
      select.addEventListener("change", () => this.load(true));
      label.append(select);
      parent.append(label);
      return select;
    }
    async request(action, params) {
      const base = new URL(this.dataset.proxy, location.origin);
      if (base.origin !== location.origin) throw new Error("Invalid proxy");
      const response = await fetch(
        `${base.pathname}/${action}?${new URLSearchParams(params)}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      if (!response.ok) throw new Error("Reviews unavailable");
      return response.json();
    }
    async load(reset) {
      const generation = ++this.generation;
      if (reset) {
        this.cursor = null;
        this.rows?.replaceChildren();
      }
      this.status.textContent = "Loading reviews…";
      if (this.more) this.more.disabled = true;
      try {
        const data = await this.request("list", {
          productId: this.dataset.productId,
          sort: this.sort?.value || "newest",
          limit: this.dataset.mode === "stars" ? "1" : "10",
          ...(this.rating?.value ? { rating: this.rating.value } : {}),
          ...(this.cursor ? { cursor: this.cursor } : {}),
        });
        if (generation !== this.generation || !this.isConnected) return;
        this.summary.textContent = data.summary.count
          ? `${data.summary.average} out of 5 · ${data.summary.count} ${data.summary.count === 1 ? "review" : "reviews"}`
          : "No reviews yet";
        if (this.rows) {
          for (const review of data.items) this.rows.append(this.card(review));
          this.cursor = data.nextCursor;
          this.more.hidden = !this.cursor;
        }
        this.status.textContent =
          this.rows && reset && !data.items.length
            ? "No reviews match this filter."
            : "";
      } catch {
        if (generation === this.generation)
          this.status.textContent =
            "Reviews are temporarily unavailable. Please try again later.";
      } finally {
        if (generation === this.generation && this.more)
          this.more.disabled = false;
      }
    }
    card(review) {
      const article = element("article");
      article.append(
        element("p", `${review.rating} out of 5 stars`),
        element("h3", review.title),
        element(
          "p",
          `${review.displayName} · ${new Date(review.createdAt).toLocaleDateString()}${review.verifiedPurchase ? " · Verified purchase" : ""}`,
          "wr-meta",
        ),
        element("p", review.body),
      );
      if (review.incentivized)
        article.append(
          element(
            "p",
            "The reviewer received loyalty points for this review, regardless of rating.",
            "wr-meta",
          ),
        );
      if (review.merchantReply) {
        const reply = element("div", undefined, "wr-reply");
        reply.append(
          element("strong", "Store reply"),
          element("p", review.merchantReply),
        );
        article.append(reply);
      }
      if (review.media.length) {
        const photos = element("div", undefined, "wr-photos");
        article.append(photos);
        for (const [index, media] of review.media.entries())
          this.request("photo", { mediaId: media.id })
            .then((result) => {
              // Pagination keeps existing cards alive; only discard images
              // belonging to cards removed by a filter change or disconnect.
              if (!this.isConnected || !this.contains(article)) return;
              const url = new URL(result.url);
              if (url.protocol !== "https:") return;
              const img = element("img");
              img.src = url.href;
              img.alt = `Customer review photo ${index + 1}`;
              img.loading = "lazy";
              img.referrerPolicy = "no-referrer";
              photos.append(img);
            })
            .catch(() => {
              /* Omit unavailable photos without hiding the review. */
            });
      }
      return article;
    }
  }
  customElements.define("weletic-reviews", WeleticReviews);
})();
