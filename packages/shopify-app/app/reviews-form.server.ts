import { randomBytes } from "node:crypto";

// Static markup only: untrusted review/product text is assigned with textContent.
// The bearer token lives in the fragment, never the query string or storage.
export function reviewFormResponse() {
  const nonce = randomBytes(24).toString("base64");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Write a verified review</title><style nonce="${nonce}">
body{font:16px/1.6 system-ui,sans-serif;color:#172033;background:#f6f7f9;margin:0;padding:24px}
main{max-width:620px;margin:32px auto;background:white;border:1px solid #dfe3e8;border-radius:16px;padding:32px}
h1{font-size:28px;line-height:1.2}label{display:block;margin:18px 0 6px;font-weight:600}input,select,textarea,button{font:inherit;box-sizing:border-box}input:not([type=checkbox]),select,textarea{width:100%;padding:10px;border:1px solid #97a0af;border-radius:6px}textarea{min-height:160px}button{background:#182a4b;color:white;padding:12px 20px;border:0;border-radius:6px;cursor:pointer;margin-top:20px}button:disabled{opacity:.5}small{display:block;color:#4c596e}.consent{font-weight:400}#status{white-space:pre-wrap}fieldset{border:0;padding:0;margin:0}a{color:#163f7a}
</style></head><body><main><h1>Share your honest review</h1><p id="product">Checking your invitation…</p>
<p id="status" role="status" aria-live="polite"></p><form id="review" hidden><fieldset id="fields">
<label for="rating">Rating</label><select id="rating" name="rating" required><option value="">Choose a rating</option><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3">3 — Average</option><option value="2">2 — Below expectations</option><option value="1">1 — Poor</option></select>
<label for="displayName">Public display name</label><input id="displayName" name="displayName" maxlength="80" required autocomplete="nickname"><small>Use the name you want other shoppers to see. Do not include private contact information.</small>
<label for="title">Review title</label><input id="title" name="title" maxlength="120" required>
<label for="body">Your experience</label><textarea id="body" name="body" minlength="20" maxlength="10000" required></textarea><small>At least 20 characters. All ratings are welcome.</small>
<div id="photos" hidden><label for="photoFiles">Photos (optional)</label><input id="photoFiles" type="file" accept="image/jpeg,image/png,image/webp" multiple><small>Up to five JPEG, PNG, or WebP photos, 2 MB each. Do not upload personal documents or other people's private information.</small></div>
<label class="consent"><input type="checkbox" id="consent" required> I agree to publish this review, my display name, and any photos on this store. I own or have permission to share them.</label>
<p>Any available loyalty reward is independent of your rating. Reviews may be moderated before publication.</p>
<button type="submit">Submit review</button></fieldset></form></main>
<script nonce="${nonce}">${REVIEW_FORM_SCRIPT}</script></body></html>`,
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
  let photosEnabled = false;
  async function api(action, data) {
    const response = await fetch(base + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), cache: 'no-store', credentials: 'same-origin' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Unable to process your review. Please try later.');
    return result;
  }
  async function initialize() {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('This invitation is invalid or has expired.');
    const result = await api('request', { token });
    document.getElementById('product').textContent = result.productTitle;
    photosEnabled = result.photoUploadsEnabled;
    document.getElementById('photos').hidden = !photosEnabled;
    form.hidden = false;
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    fields.disabled = true;
    status.textContent = 'Submitting…';
    try {
      const files = photosEnabled ? Array.from(document.getElementById('photoFiles').files || []) : [];
      if (files.length > 5 || files.some(file => file.size > 2 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(file.type))) throw new Error('Choose up to five JPEG, PNG, or WebP photos, 2 MB each.');
      const mediaIds = [];
      for (const file of files) {
        if (!uploads.has(file)) {
          const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Unable to read photo')); reader.readAsDataURL(file); });
          const uploaded = await api('upload', { token, contentType: file.type, base64 });
          uploads.set(file, uploaded.id);
        }
        mediaIds.push(uploads.get(file));
      }
      const result = await api('submit', { token, rating: Number(form.elements.rating.value), title: form.elements.title.value, body: form.elements.body.value, displayName: form.elements.displayName.value, mediaIds, publishConsent: document.getElementById('consent').checked });
      form.hidden = true;
      status.textContent = result.status === 'published' ? 'Thank you. Your review is published.' : 'Thank you. Your review has been received and is awaiting moderation.';
    } catch (error) { status.textContent = error instanceof Error ? error.message : 'Unable to submit your review.'; }
    finally { fields.disabled = false; }
  });
  initialize().catch(error => { document.getElementById('product').textContent = ''; status.textContent = error instanceof Error ? error.message : 'Invitation unavailable.'; });
})();`;
