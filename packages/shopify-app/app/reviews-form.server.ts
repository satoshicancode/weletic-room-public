import { randomBytes } from "node:crypto";
import { reviewFormCopy, reviewFormLocale } from "./reviews-form-copy";

// Static markup only: untrusted review/product text is assigned with textContent.
// The bearer token lives in the fragment, never the query string or storage.
export function reviewFormResponse(localeInput?: unknown) {
  const nonce = randomBytes(24).toString("base64");
  const locale = reviewFormLocale(localeInput);
  const copy = reviewFormCopy[locale];
  const text = (key: keyof typeof copy) =>
    copy[key]
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const dictionary = JSON.stringify(reviewFormCopy).replaceAll("<", "\\u003c");
  return new Response(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title data-copy="pageTitle">${text("pageTitle")}</title><style nonce="${nonce}">
body{font:16px/1.6 system-ui,sans-serif;color:#172033;background:#f6f7f9;margin:0;padding:24px}
main{max-width:620px;margin:32px auto;background:white;border:1px solid #dfe3e8;border-radius:16px;padding:32px}
h1{font-size:28px;line-height:1.2}label{display:block;margin:18px 0 6px;font-weight:600}input,select,textarea,button{font:inherit;box-sizing:border-box}input:not([type=checkbox]),select,textarea{width:100%;padding:10px;border:1px solid #97a0af;border-radius:6px}textarea{min-height:160px}button{background:#182a4b;color:white;padding:12px 20px;border:0;border-radius:6px;cursor:pointer;margin-top:20px}button:disabled{opacity:.5}small{display:block;color:#4c596e}.consent{font-weight:400}#status{white-space:pre-wrap}fieldset{border:0;padding:0;margin:0}a{color:#163f7a}
</style></head><body><main><label for="language" data-copy="language">${text("language")}</label><select id="language"><option value="en" ${locale === "en" ? "selected" : ""}>English</option><option value="ja" ${locale === "ja" ? "selected" : ""}>日本語</option><option value="vi" ${locale === "vi" ? "selected" : ""}>Tiếng Việt</option></select><h1 data-copy="heading">${text("heading")}</h1><p id="product">${text("checking")}</p>
<p id="status" role="status" aria-live="polite"></p><form id="review" hidden><fieldset id="fields">
<label for="rating" data-copy="rating">${text("rating")}</label><select id="rating" name="rating" required><option value="" data-copy="chooseRating">${text("chooseRating")}</option><option value="5" data-copy="excellent">${text("excellent")}</option><option value="4" data-copy="good">${text("good")}</option><option value="3" data-copy="average">${text("average")}</option><option value="2" data-copy="below">${text("below")}</option><option value="1" data-copy="poor">${text("poor")}</option></select>
<label for="displayName" data-copy="displayName">${text("displayName")}</label><input id="displayName" name="displayName" maxlength="80" required autocomplete="nickname" aria-describedby="name-help"><small id="name-help" data-copy="nameHelp">${text("nameHelp")}</small>
<label for="title" data-copy="title">${text("title")}</label><input id="title" name="title" maxlength="120" required>
<label for="body" data-copy="body">${text("body")}</label><textarea id="body" name="body" minlength="20" maxlength="10000" required aria-describedby="body-help"></textarea><small id="body-help" data-copy="bodyHelp">${text("bodyHelp")}</small>
<div id="photos" hidden><label for="photoFiles" data-copy="photos">${text("photos")}</label><input id="photoFiles" type="file" accept="image/jpeg,image/png,image/webp" multiple aria-describedby="photo-help"><small id="photo-help" data-copy="photoHelp">${text("photoHelp")}</small></div>
<label class="consent"><input type="checkbox" id="consent" required> <span data-copy="consent">${text("consent")}</span></label>
<p data-copy="rewardNotice">${text("rewardNotice")}</p>
<button type="submit" data-copy="submit">${text("submit")}</button></fieldset></form></main>
<script nonce="${nonce}">const REVIEW_FORM_COPY = ${dictionary};${REVIEW_FORM_SCRIPT}</script></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`,
      },
    },
  );
}

export const REVIEW_FORM_SCRIPT = String.raw`
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  // Keep in this closure only; clear it from copied URLs and browser history.
  history.replaceState(null, '', location.pathname);
  const base = location.pathname.replace(/\/write\/?$/, '');
  const form = document.getElementById('review');
  const fields = document.getElementById('fields');
  const status = document.getElementById('status');
  const uploads = new Map();
  const language = document.getElementById('language');
  let locale = document.documentElement.lang;
  let statusKey = null;
  let ready = false;
  let submitting = false;
  let completed = false;
  let uncertain = false;
  let photosEnabled = false;
  const copy = () => REVIEW_FORM_COPY[locale];
  function showStatus(key) {
    statusKey = key;
    status.textContent = copy()[key];
  }
  language.addEventListener('change', () => {
    if (!Object.hasOwn(REVIEW_FORM_COPY, language.value)) return;
    locale = language.value;
    document.documentElement.lang = locale;
    document.querySelectorAll('[data-copy]').forEach(node => {
      node.textContent = copy()[node.dataset.copy];
    });
    if (!ready) document.getElementById('product').textContent = statusKey ? '' : copy().checking;
    if (statusKey) showStatus(statusKey);
  });
  async function api(action, data) {
    const response = await fetch(base + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), cache: 'no-store', credentials: 'same-origin' });
    const result = await response.json();
    // Provider/server messages may contain private details. Only local copy is shown.
    if (!response.ok) throw new Error(response.status === 404 || response.status === 403 ? 'invalid' : response.status === 400 ? 'invalidInput' : action === 'submit' ? 'uncertain' : 'unavailable');
    return result;
  }
  async function initialize() {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid');
    const result = await api('request', { token });
    if (!result || typeof result.productTitle !== 'string' || typeof result.photoUploadsEnabled !== 'boolean') throw new Error('unavailable');
    document.getElementById('product').textContent = result.productTitle;
    photosEnabled = result.photoUploadsEnabled;
    document.getElementById('photos').hidden = !photosEnabled;
    form.hidden = false;
    ready = true;
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!ready || submitting || completed || uncertain) return;
    if (!form.reportValidity()) return;
    submitting = true;
    fields.disabled = true;
    showStatus('submitting');
    try {
      const files = photosEnabled ? Array.from(document.getElementById('photoFiles').files || []) : [];
      if (files.length > 5 || files.some(file => file.size > 2 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(file.type))) throw new Error('invalidPhotos');
      const mediaIds = [];
      for (const file of files) {
        if (!uploads.has(file)) {
          const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('readPhoto')); reader.readAsDataURL(file); });
          const uploaded = await api('upload', { token, contentType: file.type, base64 });
          if (!uploaded || typeof uploaded.id !== 'string' || !/^wrevmedia_[A-Za-z0-9_-]+$/.test(uploaded.id) || uploaded.id.length > 191) throw new Error('unavailable');
          uploads.set(file, uploaded.id);
        }
        mediaIds.push(uploads.get(file));
      }
      const result = await api('submit', { token, rating: Number(form.elements.rating.value), title: form.elements.title.value, body: form.elements.body.value, displayName: form.elements.displayName.value, mediaIds, publishConsent: document.getElementById('consent').checked });
      if (!result || !['published', 'pending'].includes(result.status)) throw new Error('uncertain');
      completed = true;
      form.hidden = true;
      showStatus(result.status);
    } catch (error) {
      const key = error instanceof Error && ['invalid', 'invalidInput', 'invalidPhotos', 'readPhoto', 'unavailable', 'uncertain'].includes(error.message) ? error.message : 'uncertain';
      uncertain = key === 'uncertain';
      showStatus(key);
    }
    finally { submitting = false; fields.disabled = completed || uncertain; }
  });
  initialize().catch(error => { document.getElementById('product').textContent = ''; showStatus(error instanceof Error && error.message === 'invalid' ? 'invalid' : 'unavailable'); });
})();`;
