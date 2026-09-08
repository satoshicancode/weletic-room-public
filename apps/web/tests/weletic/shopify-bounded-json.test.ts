import { readBoundedShopifyJson } from "@/lib/weletic/shopify/read-bounded-json";
import { describe, expect, it, vi } from "vitest";

describe("bounded Shopify service responses", () => {
  it("cancels a stalled body when the original HTTP deadline expires", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const pending = readBoundedShopifyJson(response, controller.signal);
    const assertion = expect(pending).rejects.toThrow("expired");
    controller.abort();
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("refuses an already expired response", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readBoundedShopifyJson(Response.json({ ok: true }), controller.signal),
    ).rejects.toThrow("expired");
  });

  it("counts UTF-8 bytes and cancels before accepting oversized JSON", async () => {
    await expect(
      readBoundedShopifyJson(
        Response.json("日".repeat(10)),
        new AbortController().signal,
        20,
      ),
    ).rejects.toThrow("too large");
  });

  it("decodes split multibyte characters without corruption", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ text: "日本語" }));
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
    );
    expect(
      await readBoundedShopifyJson(response, new AbortController().signal),
    ).toEqual({ text: "日本語" });
  });
});
