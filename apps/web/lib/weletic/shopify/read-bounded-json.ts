/** Keep the response body under the same deadline as the HTTP headers. */
export async function readBoundedShopifyJson(
  response: Response,
  signal: AbortSignal,
  maximumBytes = 32 * 1024,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing service response");
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let bytes = 0;
    while (true) {
      if (signal.aborted) throw new Error("Service response expired");
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("Service response expired");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw new Error("Service response too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
