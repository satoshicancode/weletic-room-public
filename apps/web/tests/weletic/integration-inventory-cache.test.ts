import useIntegrations from "@/lib/swr/use-integrations";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ workspace: vi.fn(), swr: vi.fn() }));
vi.mock("@/lib/swr/use-workspace", () => ({ default: mocks.workspace }));
vi.mock("swr", () => ({ default: mocks.swr }));
describe("integration inventory cache isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.swr.mockReturnValue({});
    mocks.workspace.mockReturnValue({ id: "workspace-one" });
  });
  it("does not fetch before workspace identity exists", () => {
    mocks.workspace.mockReturnValue({});
    useIntegrations();
    expect(mocks.swr.mock.calls[0][0]).toBeNull();
  });
  it("keys by workspace and refuses previous-tenant data even with an override", () => {
    useIntegrations();
    mocks.workspace.mockReturnValue({ id: "workspace-two" });
    useIntegrations({ swrOpts: { keepPreviousData: true } });
    expect(mocks.swr.mock.calls.map(([key]) => key)).toEqual([
      "/api/integrations?workspaceId=workspace-one",
      "/api/integrations?workspaceId=workspace-two",
    ]);
    expect(mocks.swr.mock.calls[1][2].keepPreviousData).toBe(false);
  });
});
