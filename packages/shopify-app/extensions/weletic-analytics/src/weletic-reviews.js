(() => {
  if (customElements.get("weletic-reviews")) return;
  const messages = {
    en: {
      loading: "Loading reviews…",
      heading: "Customer reviews",
      sort: "Sort reviews",
      newest: "Newest",
      highest: "Highest rating",
      lowest: "Lowest rating",
      filter: "Filter by rating",
      all: "All ratings",
      more: "Load more reviews",
      invitation:
        "Review invitations are sent to verified purchasers after fulfillment. All ratings are welcome; any reward is independent of rating.",
      empty: "No reviews yet",
      noMatch: "No reviews match this filter.",
      unavailable:
        "Reviews are temporarily unavailable. Please try again later.",
      verified: "Verified purchase",
      incentive: "This review was incentivized, regardless of rating.",
      reply: "Store reply",
      translated: "Manual translation",
      original: "Show original",
      translation: "Show translation",
      photo: "Customer review photo",
      stars: (n) => n + " out of 5 stars",
      summary: (average, count) =>
        average +
        " out of 5 · " +
        count +
        (count === 1 ? " review" : " reviews"),
    },
    ja: {
      loading: "レビューを読み込み中…",
      heading: "お客様のレビュー",
      sort: "並べ替え",
      newest: "新しい順",
      highest: "評価の高い順",
      lowest: "評価の低い順",
      filter: "評価で絞り込む",
      all: "すべての評価",
      more: "レビューをもっと見る",
      invitation:
        "購入が確認されたお客様に発送後、レビューを依頼します。すべての評価を歓迎し、特典は評価に左右されません。",
      empty: "レビューはまだありません",
      noMatch: "条件に一致するレビューはありません。",
      unavailable: "レビューを表示できません。後でもう一度お試しください。",
      verified: "購入確認済み",
      incentive: "このレビューには評価に関係なく特典が提供されました。",
      reply: "ストアからの返信",
      translated: "手動翻訳",
      original: "原文を表示",
      translation: "翻訳を表示",
      photo: "お客様のレビュー写真",
      stars: (n) => "5点中" + n + "点",
      summary: (average, count) =>
        "5点中" + average + "点 · " + count + "件のレビュー",
    },
    vi: {
      loading: "Đang tải đánh giá…",
      heading: "Đánh giá của khách hàng",
      sort: "Sắp xếp",
      newest: "Mới nhất",
      highest: "Điểm cao nhất",
      lowest: "Điểm thấp nhất",
      filter: "Lọc theo điểm",
      all: "Tất cả điểm",
      more: "Xem thêm đánh giá",
      invitation:
        "Lời mời đánh giá được gửi cho người mua đã xác minh sau khi giao hàng cho đơn vị vận chuyển. Mọi mức đánh giá đều được chào đón; phần thưởng không phụ thuộc vào điểm.",
      empty: "Chưa có đánh giá",
      noMatch: "Không có đánh giá phù hợp.",
      unavailable: "Tạm thời không thể tải đánh giá. Vui lòng thử lại sau.",
      verified: "Đã xác minh mua hàng",
      incentive:
        "Đánh giá này được khuyến khích bằng phần thưởng, không phụ thuộc vào điểm.",
      reply: "Phản hồi của cửa hàng",
      translated: "Bản dịch thủ công",
      original: "Xem bản gốc",
      translation: "Xem bản dịch",
      photo: "Ảnh đánh giá của khách hàng",
      stars: (n) => n + " trên 5 sao",
      summary: (average, count) => average + " trên 5 · " + count + " đánh giá",
    },
  };
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
      const language = (
        this.dataset.locale ||
        document.documentElement.lang ||
        "en"
      )
        .toLowerCase()
        .split("-")[0];
      this.locale = Object.hasOwn(messages, language) ? language : "en";
      this.copy = messages[this.locale];
      this.lang = this.locale;
      this.generation = 0;
      this.cursor = null;
      this.replaceChildren();
      this.summary = element("p", "", "wr-summary");
      this.status = element("p", this.copy.loading);
      this.status.setAttribute("role", "status");
      this.status.setAttribute("aria-live", "polite");
      this.append(this.summary, this.status);
      if (this.dataset.mode === "full") {
        this.prepend(element("h2", this.copy.heading));
        const filters = element("div", undefined, "wr-filters");
        this.sort = this.select(
          this.copy.sort,
          [
            ["newest", this.copy.newest],
            ["highest", this.copy.highest],
            ["lowest", this.copy.lowest],
          ],
          filters,
        );
        this.rating = this.select(
          this.copy.filter,
          [
            ["", this.copy.all],
            ...[5, 4, 3, 2, 1].map((n) => [String(n), this.copy.stars(n)]),
          ],
          filters,
        );
        this.rows = element("div");
        this.more = element("button", this.copy.more);
        this.more.type = "button";
        this.more.hidden = true;
        this.more.addEventListener("click", () => this.load(false));
        this.append(filters, this.rows, this.more);
        this.append(element("p", this.copy.invitation, "wr-meta"));
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
      this.status.textContent = this.copy.loading;
      if (this.more) this.more.disabled = true;
      try {
        const data = await this.request("list", {
          productId: this.dataset.productId,
          locale: this.locale,
          sort: this.sort?.value || "newest",
          limit: this.dataset.mode === "stars" ? "1" : "10",
          ...(this.rating?.value ? { rating: this.rating.value } : {}),
          ...(this.cursor ? { cursor: this.cursor } : {}),
        });
        if (generation !== this.generation || !this.isConnected) return;
        this.summary.textContent = data.summary.count
          ? this.copy.summary(data.summary.average, data.summary.count)
          : this.copy.empty;
        if (this.rows) {
          for (const review of data.items) this.rows.append(this.card(review));
          this.cursor = data.nextCursor;
          this.more.hidden = !this.cursor;
        }
        this.status.textContent =
          this.rows && reset && !data.items.length ? this.copy.noMatch : "";
      } catch {
        if (generation === this.generation) {
          this.rows?.replaceChildren();
          this.summary.textContent = "";
          this.cursor = null;
          if (this.more) this.more.hidden = true;
          this.status.textContent = this.copy.unavailable;
        }
      } finally {
        if (generation === this.generation && this.more)
          this.more.disabled = false;
      }
    }
    card(review) {
      const article = element("article");
      const title = element("h3", review.title);
      const body = element("p", review.body);
      article.append(
        element("p", this.copy.stars(review.rating)),
        title,
        element(
          "p",
          `${review.displayName} · ${new Date(review.createdAt).toLocaleDateString(this.locale)}${review.verifiedPurchase ? " · " + this.copy.verified : ""}`,
          "wr-meta",
        ),
        body,
      );
      if (
        review.translation?.locale === this.locale &&
        typeof review.translation.original?.title === "string" &&
        typeof review.translation.original?.body === "string"
      ) {
        const toggle = element("button", this.copy.original);
        toggle.type = "button";
        toggle.setAttribute("aria-pressed", "false");
        let showingOriginal = false;
        toggle.addEventListener("click", () => {
          showingOriginal = !showingOriginal;
          title.textContent = showingOriginal
            ? review.translation.original.title
            : review.title;
          body.textContent = showingOriginal
            ? review.translation.original.body
            : review.body;
          toggle.textContent = showingOriginal
            ? this.copy.translation
            : this.copy.original;
          toggle.setAttribute("aria-pressed", String(showingOriginal));
        });
        article.append(element("p", this.copy.translated, "wr-meta"), toggle);
      }
      if (review.incentivized)
        article.append(element("p", this.copy.incentive, "wr-meta"));
      if (review.merchantReply) {
        const reply = element("div", undefined, "wr-reply");
        reply.append(
          element("strong", this.copy.reply),
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
              img.alt = `${this.copy.photo} ${index + 1}`;
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
