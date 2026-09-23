(() => {
  if (customElements.get("weletic-store-reviews")) return;
  const copy = {
    en: {
      heading: "Store experience reviews",
      loading: "Loading store reviews…",
      filter: "Filter by rating",
      all: "All ratings",
      more: "Load more reviews",
      empty: "No store reviews yet",
      noMatch: "No reviews match this filter.",
      unavailable:
        "Store reviews are temporarily unavailable. Please try again later.",
      verified: "Verified purchase",
      incentive: "Incentivized regardless of rating",
      reply: "Store reply",
      stars: (n) => `${n} out of 5 stars`,
      summary: (average, count) =>
        `${average} out of 5 · ${count} ${count === 1 ? "review" : "reviews"}`,
    },
    ja: {
      heading: "ストア体験のレビュー",
      loading: "ストアのレビューを読み込み中…",
      filter: "評価で絞り込む",
      all: "すべての評価",
      more: "レビューをもっと見る",
      empty: "ストアのレビューはまだありません",
      noMatch: "条件に一致するレビューはありません。",
      unavailable:
        "ストアのレビューを表示できません。後でもう一度お試しください。",
      verified: "購入確認済み",
      incentive: "評価に関係なく特典が提供されました",
      reply: "ストアからの返信",
      stars: (n) => `5点中${n}点`,
      summary: (average, count) => `5点中${average}点 · ${count}件のレビュー`,
    },
    vi: {
      heading: "Đánh giá trải nghiệm cửa hàng",
      loading: "Đang tải đánh giá cửa hàng…",
      filter: "Lọc theo điểm",
      all: "Tất cả điểm",
      more: "Xem thêm đánh giá",
      empty: "Chưa có đánh giá cửa hàng",
      noMatch: "Không có đánh giá phù hợp.",
      unavailable:
        "Tạm thời không thể tải đánh giá cửa hàng. Vui lòng thử lại sau.",
      verified: "Đã xác minh mua hàng",
      incentive: "Có thưởng, không phụ thuộc vào điểm",
      reply: "Phản hồi của cửa hàng",
      stars: (n) => `${n} trên 5 sao`,
      summary: (average, count) => `${average} trên 5 · ${count} đánh giá`,
    },
  };
  const element = (tag, value, className) => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  class WeleticStoreReviews extends HTMLElement {
    connectedCallback() {
      if (this.initialized) {
        this.load(true);
        return;
      }
      this.initialized = true;
      this.generation = 0;
      this.cursor = null;
      const language = (
        this.dataset.locale ||
        document.documentElement.lang ||
        "en"
      )
        .toLowerCase()
        .split("-")[0];
      this.locale = Object.hasOwn(copy, language) ? language : "en";
      this.lang = this.locale;
      this.messages = copy[this.locale];
      this.replaceChildren();
      this.append(element("h2", this.messages.heading));
      this.summary = element("p", "", "wsr-summary");
      this.status = element("p", this.messages.loading);
      this.status.setAttribute("role", "status");
      this.status.setAttribute("aria-live", "polite");
      const controls = element("div", undefined, "wsr-controls");
      const label = element("label", `${this.messages.filter} `);
      this.rating = element("select");
      for (const [value, caption] of [
        ["", this.messages.all],
        ...[5, 4, 3, 2, 1].map((n) => [String(n), this.messages.stars(n)]),
      ]) {
        const option = element("option", caption);
        option.value = value;
        this.rating.append(option);
      }
      this.rating.addEventListener("change", () => this.load(true));
      label.append(this.rating);
      controls.append(label);
      this.rows = element("div");
      this.more = element("button", this.messages.more);
      this.more.type = "button";
      this.more.hidden = true;
      this.more.addEventListener("click", () => this.load(false));
      this.append(this.summary, controls, this.rows, this.more, this.status);
      this.load(true);
    }
    disconnectedCallback() {
      this.generation += 1;
    }
    async load(reset) {
      const generation = ++this.generation;
      if (reset) {
        this.cursor = null;
        this.rows.replaceChildren();
      }
      this.status.textContent = this.messages.loading;
      this.more.disabled = true;
      try {
        const base = new URL(this.dataset.proxy, location.origin);
        if (base.origin !== location.origin) throw new Error("Invalid proxy");
        const query = new URLSearchParams({ limit: "10" });
        if (this.rating.value) query.set("rating", this.rating.value);
        if (this.cursor) query.set("cursor", this.cursor);
        const response = await fetch(`${base.pathname}/store-list?${query}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error("Store reviews unavailable");
        const data = await response.json();
        if (
          !data ||
          !data.summary ||
          !Array.isArray(data.items) ||
          typeof data.summary.count !== "number"
        )
          throw new Error("Invalid store reviews");
        if (generation !== this.generation || !this.isConnected) return;
        this.summary.textContent = data.summary.count
          ? this.messages.summary(data.summary.average, data.summary.count)
          : this.messages.empty;
        for (const review of data.items) this.rows.append(this.card(review));
        this.cursor = data.nextCursor || null;
        this.more.hidden = !this.cursor;
        this.status.textContent =
          reset && !data.items.length && data.summary.count
            ? this.messages.noMatch
            : "";
      } catch {
        if (generation === this.generation) {
          this.rows.replaceChildren();
          this.summary.textContent = "";
          this.cursor = null;
          this.more.hidden = true;
          this.status.textContent = this.messages.unavailable;
        }
      } finally {
        if (generation === this.generation) this.more.disabled = false;
      }
    }
    card(review) {
      const article = element("article");
      article.append(
        element("p", this.messages.stars(review.rating)),
        element("h3", review.title),
        element(
          "p",
          `${review.displayName} · ${new Date(review.createdAt).toLocaleDateString(this.locale)}${review.verifiedPurchase ? " · " + this.messages.verified : ""}`,
          "wsr-meta",
        ),
        element("p", review.body),
      );
      if (review.incentivized)
        article.append(element("p", this.messages.incentive, "wsr-meta"));
      if (review.merchantReply) {
        const reply = element("div", undefined, "wsr-reply");
        reply.append(
          element("strong", this.messages.reply),
          element("p", review.merchantReply),
        );
        article.append(reply);
      }
      return article;
    }
  }
  customElements.define("weletic-store-reviews", WeleticStoreReviews);
})();
