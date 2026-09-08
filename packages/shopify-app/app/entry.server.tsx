import type { EntryContext } from "@remix-run/node";
import { createReadableStreamFromReadable } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import * as isbotModule from "isbot";
import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import shopify from "./shopify.server";

const ABORT_DELAY_MS = 5_000;

export function setDocumentResponseHeaders(
  request: Request,
  responseHeaders: Headers,
) {
  shopify.addDocumentResponseHeaders(request, responseHeaders);
  if (!responseHeaders.has("Content-Security-Policy")) {
    responseHeaders.set("Content-Security-Policy", "frame-ancestors 'none';");
  }
  responseHeaders.set("Referrer-Policy", "strict-origin-when-cross-origin");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
}

function isBotRequest(userAgent: string | null) {
  if (!userAgent) {
    return false;
  }
  if ("isbot" in isbotModule && typeof isbotModule.isbot === "function") {
    return isbotModule.isbot(userAgent);
  }
  if ("default" in isbotModule && typeof isbotModule.default === "function") {
    return isbotModule.default(userAgent);
  }
  return false;
}

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
) {
  setDocumentResponseHeaders(request, responseHeaders);

  const readyCallback = isBotRequest(request.headers.get("user-agent"))
    ? "onAllReady"
    : "onShellReady";

  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer
        context={remixContext}
        url={request.url}
        abortDelay={ABORT_DELAY_MS}
      />,
      {
        [readyCallback]() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          if (shellRendered) {
            console.error(error);
          }
        },
      },
    );

    setTimeout(abort, ABORT_DELAY_MS);
  });
}
