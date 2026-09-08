import { metadataCache } from "@/lib/api/metadata-cache";
import { prisma } from "@/lib/prisma";
import { ShopifyEcommerceRewardConfigSchema } from "@/lib/zod/schemas/shopify-ecommerce-reward";
import { expect, test, type Page } from "@playwright/test";
import {
  TEST_WORKSPACE,
  TEST_WORKSPACE_PASSWORD,
} from "../api/setup-test-workspace";

const rewardsPath = `/${TEST_WORKSPACE.workspace.slug}/program/groups/default/rewards`;

async function getDefaultGroupReward() {
  const program = await prisma.program.findUnique({
    where: { slug: TEST_WORKSPACE.workspace.slug },
    select: {
      id: true,
      groups: {
        where: { slug: "default" },
        take: 1,
        select: {
          id: true,
          slug: true,
          saleReward: { select: { id: true, config: true } },
        },
      },
    },
  });
  const group = program?.groups[0];
  if (!program || !group)
    throw new Error("Playwright reward group is missing.");
  return { programId: program.id, group };
}

async function removeTestRewardFromDatabase() {
  const { programId, group } = await getDefaultGroupReward();
  if (group.saleReward) {
    await prisma.$transaction([
      prisma.partnerGroup.update({
        where: { id: group.id },
        data: { saleRewardId: null },
      }),
      prisma.reward.delete({ where: { id: group.saleReward.id } }),
    ]);
  }
  await metadataCache.invalidateGroup(programId, group.id, group.slug);
}

async function removeTestRewardThroughUi(page: Page) {
  const { group } = await getDefaultGroupReward();
  if (!group.saleReward) return;
  const rewardId = group.saleReward.id;

  await page.goto(`${rewardsPath}?rewardId=shopify`);
  await expect(
    page.getByRole("heading", { name: "Edit Shopify eCommerce reward" }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove reward" }).click();
  await expect
    .poll(async () => (await getDefaultGroupReward()).group.saleReward)
    .toBeNull();
  await prisma.reward.deleteMany({
    where: { id: rewardId, programId: null },
  });
}

async function persistedActivation() {
  const { group } = await getDefaultGroupReward();
  const parsed = ShopifyEcommerceRewardConfigSchema.safeParse(
    group.saleReward?.config,
  );
  return parsed.success ? parsed.data.activation : null;
}

async function selectLifecycleMode(
  page: Page,
  currentLabel: string,
  nextLabel: string,
) {
  const lifecycle = page.getByTestId("shopify-reward-lifecycle");
  await lifecycle.getByRole("button", { name: currentLabel }).click();
  const option = page.getByRole("option", {
    name: new RegExp(`^${nextLabel}\\b`),
  });
  await expect(option).toBeVisible();
  await option.click();
}

test.describe("Shopify reward persisted lifecycle", () => {
  test.describe.configure({ retries: 0, timeout: 120_000 });

  test.afterEach(async ({ page }) => {
    try {
      await removeTestRewardThroughUi(page);
    } catch {
      await removeTestRewardFromDatabase();
    }
  });

  test("persists Draft → Scheduled → Active in the isolated Playwright workspace", async ({
    page,
  }) => {
    await page.goto(`/login?next=${encodeURIComponent(rewardsPath)}`);
    await page.locator('input[name="email"]').fill(TEST_WORKSPACE.user.email);
    await page.getByRole("button", { name: "Log in with email" }).click();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await page.locator('input[type="password"]').fill(TEST_WORKSPACE_PASSWORD);
    await page.getByRole("button", { name: "Log in with password" }).click();
    await page.waitForURL((url) => url.pathname === rewardsPath);

    await removeTestRewardThroughUi(page);

    await page.goto(`${rewardsPath}?rewardId=shopify`);
    await expect(
      page.getByRole("heading", {
        name: "Create Shopify eCommerce reward",
      }),
    ).toBeVisible();
    await selectLifecycleMode(page, "Active now", "Draft");
    await page.getByTestId("save-shopify-reward").click();
    await expect
      .poll(async () => (await persistedActivation())?.published)
      .toBe(false);

    await page.goto(`${rewardsPath}?rewardId=shopify`);
    await expect(
      page.getByRole("heading", { name: "Edit Shopify eCommerce reward" }),
    ).toBeVisible();
    await selectLifecycleMode(page, "Draft", "Scheduled");
    await page.getByLabel("Starts").fill("2035-09-01T09:00");
    await page.getByLabel("Ends (optional)").fill("2035-10-01T09:00");
    await page.getByTestId("save-shopify-reward").click();
    await expect
      .poll(async () => {
        const activation = await persistedActivation();
        return activation?.published && activation.startsAt !== null;
      })
      .toBe(true);

    await page.goto(`${rewardsPath}?rewardId=shopify`);
    await expect(
      page.getByRole("heading", { name: "Edit Shopify eCommerce reward" }),
    ).toBeVisible();
    await selectLifecycleMode(page, "Scheduled", "Active now");
    await page.getByTestId("save-shopify-reward").click();
    await expect.poll(persistedActivation).toEqual({
      published: true,
      startsAt: null,
      endsAt: null,
    });

    await removeTestRewardThroughUi(page);
    await expect.poll(persistedActivation).toBeNull();
  });
});
