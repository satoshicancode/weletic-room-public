import { describe, expect, it, vi } from "vitest";
import { createStaffExportClient } from "../../../../packages/shopify-app/app/staff-export-client";
import {
  STAFF_EXPORT_CONSISTENCY,
  type ShopifyStaffExportPage,
} from "../../lib/weletic/shopify/staff-export-contract";

const page: ShopifyStaffExportPage = {
  version: 1,
  kind: "grants",
  currentInstallationGeneration: "gen-1",
  createdBefore: "2026-09-07T00:00:00.000Z",
  consistency: STAFF_EXPORT_CONSISTENCY,
  nextCursor: "YQ",
  rows: [
    {
      id: "grant-1",
      installationGeneration: "old-gen",
      shopifyUserId: "123",
      permissions: [],
      revision: 1,
      updatedByShopifyUserId: "456",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};
describe("staff export browser contract", () => {
  it("reauthenticates each page and keeps the export boundary", async () => {
    const token = vi
      .fn()
      .mockResolvedValueOnce("one")
      .mockResolvedValueOnce("two");
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(
        Response.json({ ...page, nextCursor: null, rows: [] }),
      );
    const read = createStaffExportClient(token, transport);
    const first = await read({ kind: "grants" });
    const next = await read(
      { kind: "grants", cursor: first.nextCursor },
      first,
    );
    expect(next.nextCursor).toBeNull();
    expect(token).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]).toEqual([
      "/api/merchant/staff-export",
      expect.objectContaining({
        body: JSON.stringify({ kind: "grants", limit: 50, cursor: "YQ" }),
        credentials: "omit",
        headers: {
          Authorization: "Bearer two",
          "Content-Type": "application/json",
        },
      }),
    ]);
  });
  it.each([
    { ...page, token: "unexpected" },
    { ...page, rows: [{ ...page.rows[0], requestId: "private" }] },
    { ...page, kind: "actions", rows: [] },
    { ...page, consistency: "complete frozen snapshot" },
  ])("rejects expanded or mismatched response contracts", async (response) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(response));
    await expect(
      createStaffExportClient(
        async () => "token",
        transport,
      )({ kind: "grants" }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it.each([
    { ...page, createdBefore: "2026-09-08T00:00:00.000Z", nextCursor: null },
    { ...page, currentInstallationGeneration: "gen-2", nextCursor: null },
    page,
  ])("rejects changed or nonadvancing continuation", async (response) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(response));
    await expect(
      createStaffExportClient(async () => "token", transport)(
        { kind: "grants", cursor: "YQ" },
        page,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects a cursor without its matching preceding page before authentication", async () => {
    const token = vi.fn();
    const transport = vi.fn<typeof fetch>();
    await expect(
      createStaffExportClient(
        token,
        transport,
      )({ kind: "grants", cursor: "YQ" }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(token).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects excess rows even below the global 100-row cap", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ...page, rows: [page.rows[0], page.rows[0]] }),
      );
    await expect(
      createStaffExportClient(
        async () => "token",
        transport,
      )({ kind: "grants", limit: 1 }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it("does not retry or fall back after owner denial", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private details", { status: 403 }));
    await expect(
      createStaffExportClient(
        async () => "token",
        transport,
      )({ kind: "grants" }),
    ).rejects.toMatchObject({ code: "denied" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
