import { createComplianceExportDownload } from "@/lib/weletic/shopify/compliance-artifacts";
import { readWeleticShopifyRequestBodyBytes } from "@/lib/weletic/shopify/service-auth";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export async function GET() {
  const nonce = randomBytes(18).toString("base64");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Private Shopify export</title></head>
<body><p id="status">Preparing your private export…</p><script nonce="${nonce}">
(async()=>{const status=document.getElementById("status");const token=new URLSearchParams(location.hash.slice(1)).get("token");history.replaceState(null,"",location.pathname);if(!token){status.textContent="This private export link is invalid or expired.";return;}const response=await fetch(location.pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token}),cache:"no-store",referrerPolicy:"no-referrer"});if(!response.ok){status.textContent="This private export link is invalid or expired.";return;}const blob=await response.blob();const url=URL.createObjectURL(blob);const anchor=document.createElement("a");anchor.href=url;anchor.download=response.headers.get("x-weletic-filename")||"weletic-shopify-customer-data.json";anchor.click();URL.revokeObjectURL(url);status.textContent="Your export has downloaded.";})().catch(()=>{document.getElementById("status").textContent="The private export could not be downloaded.";});
</script></body></html>`;
  return new Response(html, {
    headers: {
      ...privateHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await params;
  const raw = await readWeleticShopifyRequestBodyBytes(request);
  if (!raw) {
    return new Response("Not found", { status: 404, headers: privateHeaders });
  }

  let token = "";
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    token = typeof parsed?.token === "string" ? parsed.token : "";
  } catch {
    return new Response("Not found", { status: 404, headers: privateHeaders });
  }
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
    return new Response("Not found", { status: 404, headers: privateHeaders });
  }

  const download = await createComplianceExportDownload({ requestId, token });
  if (!download) {
    return new Response("Not found", { status: 404, headers: privateHeaders });
  }
  const filename = `weletic-shopify-customer-data-${requestId}.json`;
  return new Response(download.body, {
    status: 200,
    headers: {
      ...privateHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Weletic-Filename": filename,
    },
  });
}
