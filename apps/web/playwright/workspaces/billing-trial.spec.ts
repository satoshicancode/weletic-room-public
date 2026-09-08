import { prisma } from "@/lib/prisma";
import { DUB_TRIAL_PERIOD_DAYS } from "@dub/utils";
import {
  applyMockActivatedPaidPlan,
  applyMockTrialToWorkspace,
  captureWorkspaceBillingTrialSnapshot,
  installBillingCheckoutMocks,
  installWorkspaceBillingReadMock,
  restoreWorkspaceBillingTrialSnapshot,
  type BillingMockTrialWorkspaceSnapshot,
} from "./billing-mocks";
import { expect, test } from "./fixtures";

function matchesDashboardOrigin(url: URL, baseURL: string) {
  const base = new URL(baseURL);
  return (
    url.port === base.port &&
    (url.hostname === base.hostname ||
      url.hostname.endsWith(`.${base.hostname}`) ||
      url.hostname === "app.localhost")
  );
}

test.describe("Billing trial checkout", () => {
  test("select Pro, success redirect, trial state and UI", async ({
    page,
    baseURL,
    workspace,
  }) => {
    const dashboardOrigin = baseURL ?? "http://localhost:8888";

    const { slug } = workspace;
    expect(workspace.plan).toBe("free");

    const snapshot = await captureWorkspaceBillingTrialSnapshot(slug);
    await installWorkspaceBillingReadMock(page, { slug });
    await installBillingCheckoutMocks(page, { slug, baseURL: dashboardOrigin });

    try {
      await page.goto(`/${slug}/settings/billing/upgrade`);
      await expect(
        page.getByRole("heading", { name: "Plans", exact: true }),
      ).toBeVisible({ timeout: 30_000 });

      const proCard = page.getByRole("heading", { name: "Pro", exact: true });
      await proCard
        .locator("xpath=ancestor::div[contains(@class,'flex-col')][1]")
        .getByRole("button", {
          name: new RegExp(`Start ${DUB_TRIAL_PERIOD_DAYS}-day trial`, "i"),
        })
        .click();

      await page.waitForURL(
        (u) => {
          const url = new URL(u);
          return (
            matchesDashboardOrigin(url, dashboardOrigin) &&
            url.searchParams.get("upgraded") === "true" &&
            url.searchParams.get("plan") === "pro"
          );
        },
        { timeout: 30_000, waitUntil: "domcontentloaded" },
      );

      await expect
        .poll(
          async () => {
            const project = await prisma.project.findUnique({
              where: { slug },
              select: { plan: true, trialEndsAt: true },
            });
            if (project?.plan !== "pro" || !project?.trialEndsAt) return null;
            return project.trialEndsAt;
          },
          { timeout: 90_000, intervals: [500, 1000, 2000] },
        )
        .not.toBeNull();

      // Hosted Checkout is intercepted outside the Next.js runtime. Reload the
      // success URL so the modal provider mounts from the final query state.
      await page.reload({ waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: /Dub Pro looks good on you/i }),
      ).toBeVisible({ timeout: 15_000 });

      await page.getByRole("button", { name: "View dashboard" }).click();
      await expect(page.getByText("Free trial", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      if (!page.isClosed()) {
        await page.unrouteAll({ behavior: "ignoreErrors" });
      }
      await restoreWorkspaceBillingTrialSnapshot(slug, snapshot);
    }
  });
});

test.describe("Free trial user navigation", () => {
  let slug: string;
  let preMockTrialWorkspace: BillingMockTrialWorkspaceSnapshot | undefined;

  test.beforeEach(async ({ page, workspace }) => {
    slug = workspace.slug;

    preMockTrialWorkspace = await captureWorkspaceBillingTrialSnapshot(slug);
    await applyMockTrialToWorkspace(slug);
    await installWorkspaceBillingReadMock(page, { slug });
  });

  test.afterEach(async ({ page }) => {
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
    if (slug && preMockTrialWorkspace) {
      await restoreWorkspaceBillingTrialSnapshot(slug, preMockTrialWorkspace);
    }
  });

  test("billing settings page shows trial banner and CTAs", async ({
    page,
  }) => {
    await page.goto(`/${slug}/settings/billing`);

    await expect(page.getByText(/Trial ends on/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("button", { name: "Start paid plan" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "View plans" })).toBeVisible();
  });

  test("upgrade page shows Activate plan for current Business plan", async ({
    page,
  }) => {
    await page.goto(`/${slug}/settings/billing/upgrade`);

    await expect(
      page.getByRole("heading", { name: "Plans", exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    await expect(
      page.getByRole("heading", { name: "Business", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Activate plan", exact: true }),
    ).toBeVisible();
  });

  test("activating plan from billing page shows upgraded modal", async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname.endsWith("/billing/activate-paid-plan"),
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        await applyMockActivatedPaidPlan(slug);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      },
    );

    await page.goto(`/${slug}/settings/billing`);

    await page.getByRole("button", { name: "Start paid plan" }).click();
    const confirmModal = page.getByRole("dialog").filter({
      has: page.getByRole("heading", { name: "Plan start confirmation" }),
    });
    await expect(confirmModal).toBeVisible();
    await expect(
      confirmModal.getByText(
        "You'll be charged today and your trial will end.",
      ),
    ).toBeVisible();
    const activationResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith(
          "/billing/activate-paid-plan",
        ),
    );
    await confirmModal.getByRole("button", { name: "Start paid plan" }).click();
    const activationResponse = await activationResponsePromise;
    expect(activationResponse.ok()).toBe(true);

    await expect(page).toHaveURL((url) => {
      return (
        url.searchParams.get("upgraded") === "true" &&
        url.searchParams.get("plan") === "business"
      );
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /Dub Business looks good on you/i }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
