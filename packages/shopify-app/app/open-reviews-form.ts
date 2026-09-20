import { reviewFormCopy } from "./reviews-form-copy";

export const openReviewFormCopy = {
  en: {
    ...reviewFormCopy.en,
    pageTitle: "Write a product review",
    checking: "Checking review availability…",
    rewardNotice:
      "This review is unverified and earns no points or coupon. All ratings are welcome and follow the same moderation policy.",
    invalid:
      "Reviews are unavailable for this product or session. Sign in to this store to continue.",
    uncertain:
      "We could not confirm the result. Retry the same submission below; your review will not be submitted twice.",
    retry: "Retry the same submission",
  },
  ja: {
    ...reviewFormCopy.ja,
    pageTitle: "商品レビューを書く",
    checking: "レビューの受付状況を確認しています…",
    rewardNotice:
      "このレビューは購入確認なしで投稿され、ポイントやクーポンは付与されません。すべての評価に同じ確認方針が適用されます。",
    invalid:
      "この商品またはセッションではレビューを受け付けられません。ストアにログインしてください。",
    uncertain:
      "結果を確認できませんでした。下のボタンから同じ内容を再送信してください。二重投稿にはなりません。",
    retry: "同じ内容で再送信",
  },
  vi: {
    ...reviewFormCopy.vi,
    pageTitle: "Viết đánh giá sản phẩm",
    checking: "Đang kiểm tra khả năng gửi đánh giá…",
    rewardNotice:
      "Đánh giá này không được xác minh mua hàng và không nhận điểm hoặc mã giảm giá. Mọi mức đánh giá đều được áp dụng cùng một chính sách kiểm duyệt.",
    invalid:
      "Không thể gửi đánh giá cho sản phẩm hoặc phiên này. Vui lòng đăng nhập vào cửa hàng.",
    uncertain:
      "Chưa xác nhận được kết quả. Hãy thử gửi lại cùng nội dung bằng nút bên dưới; đánh giá sẽ không bị gửi trùng.",
    retry: "Gửi lại cùng nội dung",
  },
};

// Static script only. No customer identifiers, email, bearer tokens or merchant
// configuration are interpolated into markup. Retry payload stays in memory.
export const OPEN_REVIEW_FORM_SCRIPT = String.raw`
(() => {
  const productId = new URLSearchParams(location.search).get('productId');
  const base = location.pathname.replace(/\/open-write\/?$/, '');
  const form = document.getElementById('review');
  const fields = document.getElementById('fields');
  const status = document.getElementById('status');
  const language = document.getElementById('language');
  const retry = document.getElementById('retry');
  status.tabIndex = -1;
  retry.setAttribute('aria-describedby', 'status');
  let locale = document.documentElement.lang;
  let statusKey = null, policy = null, pending = null, busy = false, completed = false, uncertain = false, photosEnabled = false;
  let uploads = [], submissionDispatched = false;
  function show(key) { statusKey = key; status.textContent = REVIEW_FORM_COPY[locale][key]; }
  language.addEventListener('change', () => {
    if (!Object.hasOwn(REVIEW_FORM_COPY, language.value)) return;
    locale = language.value;
    document.documentElement.lang = locale;
    document.querySelectorAll('[data-copy]').forEach(node => { node.textContent = REVIEW_FORM_COPY[locale][node.dataset.copy]; });
    if (statusKey) show(statusKey);
  });
  async function api(action, data) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(base + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0, text = '';
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength; if (size > 8192) throw new Error('unavailable');
          text += decoder.decode(chunk.value, { stream: true });
        }
        const result = JSON.parse(text + decoder.decode());
        if (!response.ok) {
          if (action === 'open-upload' && response.status === 400 && result?.error?.code === 'invalid_open_photo') throw new Error('invalidPhoto');
          throw new Error(response.status === 400 && result?.error?.code === 'invalid_review_input' ? 'invalidInput' : 'unavailable');
        }
        return result;
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    } finally { clearTimeout(timeout); }
  }
  async function send() {
    if (busy || completed || !pending) return;
    busy = true; fields.disabled = true; retry.disabled = true; language.disabled = true; show('submitting');
    try {
      for (const upload of uploads) {
        if (upload.id) continue;
        const receipt = await api('open-upload', upload.payload);
        if (!receipt || typeof receipt.id !== 'string' || !/^wrevmedia_[A-Za-z0-9_-]+$/.test(receipt.id) || receipt.id.length > 191) throw new Error('uncertain');
        upload.id = receipt.id;
      }
      pending.mediaIds = uploads.map(upload => upload.id);
      submissionDispatched = true;
      const result = await api('open-submit', pending);
      if (result.status !== 'received' || typeof result.duplicate !== 'boolean') throw new Error('uncertain');
      completed = true; uploads = []; pending = null; document.getElementById('photoFiles').value = ''; retry.hidden = true; form.hidden = true; show('pending');
    } catch (error) {
      if (error.message === 'invalidPhoto' && !submissionDispatched) {
        // No review was dispatched. Earlier uploaded photos are left to their
        // expiry jobs; never pretend a remote object was deleted here.
        pending = null; uploads = []; uncertain = false; fields.disabled = false; retry.hidden = true; show('invalidPhotos');
      } else if (error.message === 'invalidInput' && !uncertain && uploads.length === 0) {
        pending = null; fields.disabled = false; retry.hidden = true; show('invalidInput');
      } else { uncertain = true; retry.hidden = false; show('uncertain'); }
    }
    finally {
      busy = false; retry.disabled = false; language.disabled = false;
      if (!retry.hidden) retry.focus(); else status.focus();
    }
  }
  retry.addEventListener('click', send);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || completed || pending || !policy || !form.reportValidity()) return;
    const rating = Number(document.getElementById('rating').value);
    const displayName = document.getElementById('displayName').value.trim();
    const title = document.getElementById('title').value.trim();
    const body = document.getElementById('body').value.trim();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !displayName || displayName.length > 80 || !title || title.length > 120 || body.length < 20 || body.length > 10000 || !document.getElementById('consent').checked) { show('invalidInput'); return; }
    const files = photosEnabled ? Array.from(document.getElementById('photoFiles').files || []) : [];
    if (files.length > 5 || files.some(file => !file.size || file.size > 2 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(file.type))) { show('invalidPhotos'); return; }
    pending = { ...policy, submissionId: crypto.randomUUID(), locale, rating, displayName, title, body, mediaIds: [], publishConsent: true };
    submissionDispatched = false;
    busy = true; fields.disabled = true; language.disabled = true; show('submitting');
    try {
      uploads = [];
      // Read all bounded files before dispatch. Thereafter both bytes and UUIDs
      // are frozen in memory across ambiguous replies and language changes.
      for (const file of files) {
        const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reader.onabort = () => reject(new Error('readPhoto')); reader.readAsDataURL(file); });
        uploads.push({ id: null, payload: { submissionId: pending.submissionId, uploadId: crypto.randomUUID(), productId: policy.productId, expectedInstallationGeneration: policy.expectedInstallationGeneration, expectedSettingsRevision: policy.expectedSettingsRevision, authorBinding: policy.authorBinding, contentType: file.type, base64 } });
      }
    } catch {
      uploads = []; pending = null; busy = false; fields.disabled = false; language.disabled = false; show('readPhoto'); status.focus(); return;
    }
    busy = false;
    void send();
  });
  async function prepare() {
    if (!productId || !/^gid:\/\/shopify\/Product\/[1-9][0-9]{0,19}$/.test(productId)) { document.getElementById('product').textContent = ''; show('invalid'); return; }
    try {
      const result = await api('open-prepare', { productId });
      if (result.productId !== productId || typeof result.expectedInstallationGeneration !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(result.expectedInstallationGeneration) || !Number.isInteger(result.expectedSettingsRevision) || result.expectedSettingsRevision < 1 || result.expectedSettingsRevision > 2147483647 || result.disclosureRevision !== 'open_unverified_unrewarded_v1' || result.verifiedPurchase !== false || result.incentivized !== false || typeof result.photoUploadsAvailable !== 'boolean') throw new Error('invalid');
      if (typeof result.authorBinding !== 'string' || !/^[a-f0-9]{64}$/.test(result.authorBinding)) throw new Error('invalid');
      policy = { productId, expectedInstallationGeneration: result.expectedInstallationGeneration, expectedSettingsRevision: result.expectedSettingsRevision, disclosureRevision: result.disclosureRevision, authorBinding: result.authorBinding };
      photosEnabled = result.photoUploadsAvailable;
      document.getElementById('photos').hidden = !photosEnabled;
      document.getElementById('product').textContent = ''; form.hidden = false;
    } catch { document.getElementById('product').textContent = ''; show('invalid'); }
  }
  void prepare();
})();
`;
