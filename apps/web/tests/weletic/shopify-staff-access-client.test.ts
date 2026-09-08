import { afterEach, describe, expect, it, vi } from "vitest";
import { createStaffAccessClient } from "../../../../packages/shopify-app/app/staff-access-client";

const input = {
  userId: "123",
  permissions: ["reviews.read"],
  expectedRevision: 0,
};
const grant = { userId: "123", permissions: ["reviews.read"], revision: 1 };

afterEach(() => vi.useRealTimers());

describe("staff access browser client", () => {
  it("gets a fresh bearer token for each request without cookies or retries", async () => {
    const token = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ grant }))
      .mockResolvedValueOnce(Response.json({ grants: [], nextCursor: null }));
    const client = createStaffAccessClient(token, transport);
    await expect(client.save(input)).resolves.toEqual(grant);
    await client.list();
    expect(token).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0][1]).toMatchObject({
      credentials: "omit",
      cache: "no-store",
      method: "POST",
      headers: { Authorization: "Bearer first" },
    });
    expect(transport.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: "Bearer second",
    });
  });

  it.each([
    [401, "reauthenticate"],
    [403, "denied"],
    [409, "reload"],
    [400, "invalid"],
    [500, "unavailable"],
  ])("sanitizes HTTP %s without retrying a save", async (status, code) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("private provider detail", { status: Number(status) }),
      );
    await expect(
      createStaffAccessClient(async () => "token", transport).save(input),
    ).rejects.toMatchObject({ code, message: code });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...grant, userId: "456" },
    { ...grant, revision: 2 },
    { ...grant, permissions: ["loyalty.adjust"] },
    { ...grant, token: "unexpected" },
  ])(
    "rejects a successful response that does not match the mutation",
    async (changed) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ grant: changed }));
      await expect(
        createStaffAccessClient(async () => "token", transport).save(input),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects malformed inputs before requesting a token", async () => {
    const token = vi.fn();
    const transport = vi.fn<typeof fetch>();
    const client = createStaffAccessClient(token, transport);
    await expect(client.save({ ...input, userId: "01" })).rejects.toMatchObject(
      { code: "invalid" },
    );
    await expect(client.list({ limit: 101 })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(token).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("never sends when token acquisition resolves after its deadline", async () => {
    vi.useFakeTimers();
    let resolveToken!: (token: string) => void;
    const transport = vi.fn<typeof fetch>();
    const client = createStaffAccessClient(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
      transport,
    );
    const result = expect(client.save(input)).rejects.toMatchObject({
      code: "unavailable",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    resolveToken("late-token");
    await vi.advanceTimersByTimeAsync(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds a stalled response body and aborts without retrying", async () => {
    vi.useFakeTimers();
    const response = Response.json({ grant });
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = expect(
      createStaffAccessClient(async () => "token", transport).save(input),
    ).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("does not expose malformed list data as an authorized grant", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        grants: [
          {
            ...grant,
            status: "active",
            permissions: ["*"],
            updatedAt: "2026-09-07T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    );
    await expect(
      createStaffAccessClient(async () => "token", transport).list(),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
