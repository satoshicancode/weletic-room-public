import { decryptOrPassthrough } from "@/lib/encryption";
import { prisma } from "@/lib/prisma";
import { ShopifyCredentialUnavailableError } from "@/lib/weletic/shopify/credential-errors";
import { readShopifyCredentialSource } from "@/lib/weletic/shopify/credential-source";
import {
  normalizeShopDomain,
  verifyAndBindShopifyIntegrationCredential,
} from "@/lib/weletic/shopify/store-resolver";
import { SHOPIFY_INTEGRATION_ID, nanoid } from "@dub/utils";
import { Discount, Prisma, Project } from "@prisma/client";
import {
  ShopifyAdminGraphqlError,
  shopifyAdminGraphql,
} from "../integrations/shopify/admin-graphql";
import { DiscountProviderError } from "./discount-error";

export type ShopifyDiscountType =
  | "amount_off_order"
  | "amount_off_products"
  | "bxgy"
  | "free_shipping";

export interface ShopifyDiscountConfigParsed {
  type: ShopifyDiscountType;
  productIds: string[];
  collectionIds: string[];
  bxgy?: {
    buyQuantity: number;
    getQuantity: number;
    discountType: "percentage" | "amount";
    discountValue: number;
  };
  freeShipping?: {
    minimumSubtotal?: number;
    maximumShippingPrice?: number;
  };
}

export function formatShopifyGid(
  type: "Product" | "Collection" | "ProductVariant",
  id: string | number,
): string {
  const str = String(id).trim();
  if (str.startsWith("gid://shopify/")) {
    return str;
  }
  return `gid://shopify/${type}/${str}`;
}

export function parseShopifyDiscountConfig(
  discount: Pick<Discount, "amount" | "type"> & {
    description?: string | null;
    couponId?: string | null;
    shopifyConfig?: Partial<ShopifyDiscountConfigParsed>;
  },
): ShopifyDiscountConfigParsed {
  if (discount.shopifyConfig) {
    return {
      type: discount.shopifyConfig.type || "amount_off_order",
      productIds: discount.shopifyConfig.productIds || [],
      collectionIds: discount.shopifyConfig.collectionIds || [],
      bxgy: discount.shopifyConfig.bxgy,
      freeShipping: discount.shopifyConfig.freeShipping,
    };
  }

  if (discount.description) {
    try {
      const parsed = JSON.parse(discount.description);
      if (parsed && typeof parsed === "object") {
        return {
          type: parsed.type || "amount_off_order",
          productIds: Array.isArray(parsed.productIds) ? parsed.productIds : [],
          collectionIds: Array.isArray(parsed.collectionIds)
            ? parsed.collectionIds
            : [],
          bxgy: parsed.bxgy,
          freeShipping: parsed.freeShipping,
        };
      }
    } catch {
      // Not JSON description
    }
  }

  return {
    type: "amount_off_order",
    productIds: [],
    collectionIds: [],
  };
}

interface ShopifyDiscountNodeResponse {
  codeDiscountNode: {
    id: string;
    codeDiscount: {
      codes: { nodes: { code: string }[] };
    };
  } | null;
  userErrors: {
    field: string[] | null;
    message: string;
    code: string;
  }[];
}

interface ShopifyDiscountCodeBasicCreateResponse {
  discountCodeBasicCreate: ShopifyDiscountNodeResponse;
}

interface ShopifyDiscountCodeBxgyCreateResponse {
  discountCodeBxgyCreate: ShopifyDiscountNodeResponse;
}

interface ShopifyDiscountCodeFreeShippingCreateResponse {
  discountCodeFreeShippingCreate: ShopifyDiscountNodeResponse;
}

interface ShopifyDiscountCodeDelete {
  deletedCodeDiscountId: string | null;
  userErrors: {
    field: string[] | null;
    message: string;
    code: string;
  }[];
}

const MAX_ATTEMPTS = 3;

async function requireShopifyCredential(
  workspace: Pick<Project, "id" | "shopifyStoreId">,
) {
  const credentialStore = await prisma.weleticShopifyStore.findUnique({
    where: { projectId: workspace.id },
    select: { id: true, shopDomain: true, installationGeneration: true },
  });
  if (credentialStore) {
    const source = await readShopifyCredentialSource({
      storeId: credentialStore.id,
      workspaceId: workspace.id,
      shop: credentialStore.shopDomain,
      installationGeneration: credentialStore.installationGeneration,
    }).catch((error: unknown) => {
      if (error instanceof ShopifyCredentialUnavailableError)
        throw new DiscountProviderError(
          "shopify",
          "AUTH_EXPIRED",
          "Reconnect the Shopify app before accessing this store.",
        );
      throw error;
    });
    if (source.source === "native") {
      if (
        !source.scope
          .split(",")
          .map((value) => value.trim())
          .includes("write_discounts")
      )
        throw new DiscountProviderError(
          "shopify",
          "PERMISSIONS_REQUIRED",
          "The Shopify app requires write_discounts permission.",
        );
      // No fabricated generic installation ID or installer account. Public
      // authority belongs to the canonical Store/app, not a Project alias.
      return {
        nativeStore: {
          id: credentialStore.id,
          workspaceId: workspace.id,
          shop: credentialStore.shopDomain,
          installationGeneration: source.installationGeneration,
        },
        credentials: {
          shop: credentialStore.shopDomain,
          scope: source.scope,
          accessToken: source.accessToken,
        },
      };
    }
  }
  if (!workspace.shopifyStoreId) {
    throw new DiscountProviderError(
      "shopify",
      "INTEGRATION_NOT_AVAILABLE",
      "SHOPIFY_CONNECTION_REQUIRED: Your workspace isn't connected to Shopify yet. Please connect your Shopify store in settings.",
    );
  }
  const shopDomain = normalizeShopDomain(workspace.shopifyStoreId);

  // 0. A global token is safe only for explicitly targeted non-production
  // validation. Production must always resolve the exact tenant's credential.
  const permanentToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
  if (permanentToken && process.env.NODE_ENV !== "production") {
    return {
      id: "env_shopify_admin_permanent",
      projectId: workspace.id,
      credentials: {
        shop: shopDomain,
        scope:
          "read_products,write_products,read_discounts,write_discounts,read_orders,read_customers",
        accessToken: permanentToken,
      },
    };
  }

  // Only pre-admission custom installations use this legacy credential path.
  // Never substitute an SDK payload after versioned authority fails.
  if (!workspace.shopifyStoreId) {
    throw new DiscountProviderError(
      "shopify",
      "INTEGRATION_NOT_AVAILABLE",
      "SHOPIFY_CONNECTION_REQUIRED: Your workspace isn't connected to Shopify yet. Please install the Dub Shopify app in settings to create a discount.",
    );
  }

  const installation = await prisma.installedIntegration.findFirst({
    where: {
      projectId: workspace.id,
      integrationId: SHOPIFY_INTEGRATION_ID,
    },
  });

  if (!installation) {
    throw new DiscountProviderError(
      "shopify",
      "INTEGRATION_NOT_AVAILABLE",
      "SHOPIFY_CONNECTION_REQUIRED: Your workspace isn't connected to Shopify yet. Please install the Weletic Shopify app in settings to create a discount.",
    );
  }

  if (
    !credentialStore ||
    normalizeShopDomain(credentialStore.shopDomain) !== shopDomain
  ) {
    throw new DiscountProviderError(
      "shopify",
      "AUTH_EXPIRED",
      "The Shopify credential installation is no longer authoritative. Reconnect Shopify before creating discount codes.",
    );
  }

  const credentials = await verifyAndBindShopifyIntegrationCredential({
    installation,
    expectedStore: {
      id: credentialStore.id,
      installationGeneration: credentialStore.installationGeneration,
    },
    expectedShopDomain: shopDomain,
  });
  if (!credentials) {
    throw new DiscountProviderError(
      "shopify",
      "AUTH_EXPIRED",
      "The Shopify credential does not match the workspace store. Reconnect Shopify before creating discount codes.",
    );
  }
  const credentialShopDomain = normalizeShopDomain(credentials.shop || "");

  const scopes = new Set(
    credentials.scope
      ?.split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  if (!scopes.has("write_discounts")) {
    throw new DiscountProviderError(
      "shopify",
      "PERMISSIONS_REQUIRED",
      "SHOPIFY_APP_UPGRADE_REQUIRED: Your connected Shopify store doesn't have permission to create discount codes. Please reinstall or upgrade the Weletic Shopify app.",
    );
  }

  if (!credentials.accessToken) {
    throw new DiscountProviderError(
      "shopify",
      "AUTH_EXPIRED",
      "SHOPIFY_REAUTHORIZATION_REQUIRED: Reconnect Shopify before creating discount codes.",
    );
  }

  return {
    ...installation,
    credentials: {
      ...credentials,
      shop: credentialShopDomain,
      accessToken: decryptOrPassthrough(credentials.accessToken),
    },
  };
}

function throwIfShopifyUnauthorized(error: unknown): void {
  if (
    error instanceof ShopifyAdminGraphqlError &&
    error.code === "unauthorized"
  ) {
    throw new DiscountProviderError("shopify", "AUTH_EXPIRED", error.message);
  }
}

export interface CreateShopifyDiscountParams {
  workspace: Pick<Project, "id" | "shopifyStoreId">;
  discount: Pick<Discount, "id" | "amount" | "type" | "maxDuration"> & {
    description?: string | null;
    couponId?: string | null;
    shopifyConfig?: Partial<ShopifyDiscountConfigParsed>;
  };
  code: string;
  shouldRetry?: boolean;
}

function createShopifyDiscountProvider() {
  const getCoupon = async () => {
    throw new Error("Shopify does not this method.");
  };

  const createCoupon = async () => {
    throw new Error("Shopify does not this method.");
  };

  const createDiscountCode = async ({
    workspace,
    discount,
    code,
    shouldRetry = true,
  }: CreateShopifyDiscountParams) => {
    const installation = await requireShopifyCredential(workspace);
    const { credentials } = installation;
    const nativeStore =
      "nativeStore" in installation ? installation.nativeStore : null;
    const requestShopify = async <T>(
      options: Parameters<typeof shopifyAdminGraphql>[0],
    ): Promise<T> => {
      if (!nativeStore) return shopifyAdminGraphql<T>(options);
      // No automatic transaction retry around provider I/O. Suspension and
      // uninstall use the same Store lock; recheck before every remote request.
      return prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<
            Array<{
              id: string;
              projectId: string;
              shopDomain: string;
              installationGeneration: string | null;
              complianceState: string;
              storeAccessState: string;
            }>
          >(Prisma.sql`
          SELECT id, projectId, shopDomain, installationGeneration, complianceState, storeAccessState
          FROM WeleticShopifyStore WHERE id = ${nativeStore.id} LIMIT 1 FOR UPDATE
        `);
          const store = rows[0];
          if (
            !store ||
            store.projectId !== nativeStore.workspaceId ||
            store.shopDomain !== nativeStore.shop ||
            store.installationGeneration !==
              nativeStore.installationGeneration ||
            store.complianceState !== "active" ||
            store.storeAccessState !== "active"
          )
            throw new DiscountProviderError(
              "shopify",
              "PERMISSIONS_REQUIRED",
              "This company store is not approved for discount creation.",
            );
          return shopifyAdminGraphql<T>({
            ...options,
            allowSdkFallback: false,
          });
        },
        { maxWait: 5_000, timeout: 30_000 },
      );
    };
    const config = parseShopifyDiscountConfig(discount);

    // Map Dub's maxDuration (months) to Shopify's recurringCycleLimit
    // (subscription billing cycles):
    // - null  -> 0 (Shopify: applies indefinitely / forever)
    // - 0     -> 1 (one-time only -> only first subscription cycle)
    // - N     -> N (applies for N billing cycles)
    const recurringCycleLimit =
      discount.maxDuration === null
        ? 0
        : discount.maxDuration === 0
          ? 1
          : discount.maxDuration;

    let attempt = 0;
    let currentCode = code;

    // 1. If linking to an existing parent Shopify discount (couponId / GID):
    if (discount.couponId) {
      let parentGid = discount.couponId.startsWith("gid://shopify/")
        ? discount.couponId
        : /^\d+$/.test(discount.couponId)
          ? `gid://shopify/DiscountCodeNode/${discount.couponId}`
          : null;

      const targetShop = credentials.shop || workspace.shopifyStoreId || "";
      const targetToken = credentials.accessToken || "";

      if (!parentGid) {
        try {
          const lookup = await requestShopify<{
            codeDiscountNodeByCode: { id: string } | null;
          }>({
            shopifyStoreId: targetShop,
            accessToken: targetToken,
            query: `query LookupParentDiscount($code: String!) {
              codeDiscountNodeByCode(code: $code) {
                id
              }
            }`,
            variables: { code: discount.couponId },
          });
          parentGid = lookup.codeDiscountNodeByCode?.id || null;
        } catch (lookupErr) {
          console.warn("[Lookup parent discount error]", lookupErr);
        }
      }

      if (parentGid) {
        try {
          const bulkAddMutation = `mutation discountRedeemCodeBulkAdd($discountId: ID!, $codes: [DiscountRedeemCodeInput!]!) {
            discountRedeemCodeBulkAdd(discountId: $discountId, codes: $codes) {
              bulkCreation {
                id
              }
              userErrors {
                field
                message
                code
              }
            }
          }`;

          const bulkAddRes = await requestShopify<{
            discountRedeemCodeBulkAdd: {
              bulkCreation: { id: string } | null;
              userErrors: { field: string[]; message: string; code?: string }[];
            };
          }>({
            shopifyStoreId: targetShop,
            accessToken: targetToken,
            query: bulkAddMutation,
            variables: {
              discountId: parentGid,
              codes: [{ code: currentCode.toUpperCase() }],
            },
          });

          const { userErrors } = bulkAddRes.discountRedeemCodeBulkAdd;
          if (userErrors && userErrors.length > 0) {
            throw new ShopifyAdminGraphqlError(
              userErrors[0].code || "user_error",
              userErrors[0].message,
              userErrors,
            );
          }

          return {
            code: currentCode.toUpperCase(),
          };
        } catch (error) {
          if (error instanceof ShopifyAdminGraphqlError) {
            throwIfShopifyUnauthorized(error);
            const isDuplicate =
              error.code === "TAKEN" ||
              error.code === "DUPLICATE" ||
              /taken|duplicate|already exists/i.test(error.message);

            if (isDuplicate) {
              // Check if this code already exists under this EXACT parent discount node on Shopify
              try {
                const existingCheck = await requestShopify<{
                  codeDiscountNodeByCode: { id: string } | null;
                }>({
                  shopifyStoreId: targetShop,
                  accessToken: targetToken,
                  query: `query CheckExistingCode($code: String!) {
                    codeDiscountNodeByCode(code: $code) {
                      id
                    }
                  }`,
                  variables: { code: currentCode.toUpperCase() },
                });

                if (
                  existingCheck?.codeDiscountNodeByCode?.id &&
                  existingCheck.codeDiscountNodeByCode.id === parentGid
                ) {
                  // The code is ALREADY active under this exact parent discount campaign on Shopify!
                  // Safely adopt/claim the code for this partner in Weletic.
                  return {
                    code: currentCode.toUpperCase(),
                  };
                }
              } catch (checkErr) {
                console.warn("[Adopt existing code lookup error]", checkErr);
              }

              throw new DiscountProviderError(
                "shopify",
                "DISCOUNT_ALREADY_EXISTS",
                `The discount code ${currentCode} is already in use. Please choose a different code.`,
              );
            }
          }
          throw error;
        }
      }
    }

    while (attempt < MAX_ATTEMPTS) {
      try {
        let responseNode: ShopifyDiscountNodeResponse | null = null;

        if (config.type === "bxgy") {
          const buyQty = config.bxgy?.buyQuantity ?? 1;
          const getQty = config.bxgy?.getQuantity ?? 1;
          const bxgyDiscountType =
            config.bxgy?.discountType ??
            (discount.type === "flat" ? "amount" : "percentage");
          const bxgyDiscountValue =
            config.bxgy?.discountValue ??
            (discount.type === "percentage"
              ? discount.amount
              : discount.amount / 100);

          const productGids = config.productIds.map((id) =>
            formatShopifyGid("Product", id),
          );
          const collectionGids = config.collectionIds.map((id) =>
            formatShopifyGid("Collection", id),
          );

          if (productGids.length > 0 && collectionGids.length > 0) {
            throw new DiscountProviderError(
              "shopify",
              "INVALID_DISCOUNT_CONFIG",
              "Buy X Get Y item scope must contain products or collections, not both.",
            );
          }

          const items =
            productGids.length > 0 || collectionGids.length > 0
              ? {
                  ...(productGids.length > 0
                    ? { products: { productsToAdd: productGids } }
                    : {}),
                  ...(collectionGids.length > 0
                    ? { collections: { collectionsToAdd: collectionGids } }
                    : {}),
                }
              : null;

          if (!items) {
            throw new DiscountProviderError(
              "shopify",
              "INVALID_DISCOUNT_CONFIG",
              "Buy X Get Y discounts require at least one product or collection.",
            );
          }
          if (
            bxgyDiscountType === "percentage" &&
            (!Number.isFinite(bxgyDiscountValue) ||
              bxgyDiscountValue <= 0 ||
              bxgyDiscountValue > 100)
          ) {
            throw new DiscountProviderError(
              "shopify",
              "INVALID_DISCOUNT_CONFIG",
              "Buy X Get Y percentage must be greater than 0 and at most 100.",
            );
          }
          if (
            bxgyDiscountType === "amount" &&
            (!Number.isFinite(bxgyDiscountValue) || bxgyDiscountValue <= 0)
          ) {
            throw new DiscountProviderError(
              "shopify",
              "INVALID_DISCOUNT_CONFIG",
              "Buy X Get Y fixed amount must be greater than 0.",
            );
          }

          const effect =
            bxgyDiscountType === "percentage"
              ? {
                  percentage: bxgyDiscountValue / 100,
                }
              : {
                  amount: Number.isInteger(bxgyDiscountValue)
                    ? bxgyDiscountValue.toFixed(2)
                    : String(bxgyDiscountValue),
                };

          const bxgyCodeDiscount = {
            title: `Dub Discount (${currentCode})`,
            code: currentCode.toUpperCase(),
            startsAt: new Date().toISOString(),
            customerSelection: { all: true },
            appliesOncePerCustomer: true,
            usesPerOrderLimit: 1,
            customerBuys: {
              value: {
                quantity: String(buyQty),
              },
              items,
            },
            customerGets: {
              value: {
                discountOnQuantity: {
                  quantity: String(getQty),
                  effect,
                },
              },
              items,
              appliesOnOneTimePurchase: true,
              appliesOnSubscription: false,
            },
          };

          const data =
            await requestShopify<ShopifyDiscountCodeBxgyCreateResponse>({
              shopifyStoreId: credentials.shop,
              accessToken: credentials.accessToken!,
              query: /* GraphQL */ `
                mutation DiscountCodeBxgyCreate(
                  $bxgyCodeDiscount: DiscountCodeBxgyInput!
                ) {
                  discountCodeBxgyCreate(bxgyCodeDiscount: $bxgyCodeDiscount) {
                    codeDiscountNode {
                      id
                      codeDiscount {
                        ... on DiscountCodeBxgy {
                          codes(first: 1) {
                            nodes {
                              code
                            }
                          }
                        }
                      }
                    }
                    userErrors {
                      field
                      message
                      code
                    }
                  }
                }
              `,
              variables: { bxgyCodeDiscount },
            });

          responseNode = data.discountCodeBxgyCreate;
        } else if (config.type === "free_shipping") {
          const freeShipping = config.freeShipping;
          const freeShippingCodeDiscount: Record<string, unknown> = {
            title: `Dub Discount (${currentCode})`,
            code: currentCode.toUpperCase(),
            startsAt: new Date().toISOString(),
            customerSelection: { all: true },
            appliesOncePerCustomer: true,
            destination: { all: true },
            appliesOnOneTimePurchase: true,
            appliesOnSubscription: true,
            recurringCycleLimit,
          };

          if (
            freeShipping?.maximumShippingPrice != null &&
            freeShipping.maximumShippingPrice > 0
          ) {
            freeShippingCodeDiscount.maximumShippingPrice = (
              freeShipping.maximumShippingPrice / 100
            ).toFixed(2);
          }

          if (
            freeShipping?.minimumSubtotal != null &&
            freeShipping.minimumSubtotal > 0
          ) {
            freeShippingCodeDiscount.minimumRequirement = {
              subtotal: {
                greaterThanOrEqualToSubtotal: (
                  freeShipping.minimumSubtotal / 100
                ).toFixed(2),
              },
            };
          }

          const data =
            await requestShopify<ShopifyDiscountCodeFreeShippingCreateResponse>(
              {
                shopifyStoreId: credentials.shop,
                accessToken: credentials.accessToken!,
                query: /* GraphQL */ `
                  mutation DiscountCodeFreeShippingCreate(
                    $freeShippingCodeDiscount: DiscountCodeFreeShippingInput!
                  ) {
                    discountCodeFreeShippingCreate(
                      freeShippingCodeDiscount: $freeShippingCodeDiscount
                    ) {
                      codeDiscountNode {
                        id
                        codeDiscount {
                          ... on DiscountCodeFreeShipping {
                            codes(first: 1) {
                              nodes {
                                code
                              }
                            }
                          }
                        }
                      }
                      userErrors {
                        field
                        message
                        code
                      }
                    }
                  }
                `,
                variables: { freeShippingCodeDiscount },
              },
            );

          responseNode = data.discountCodeFreeShippingCreate;
        } else {
          // Amount off order or amount off products
          const isProducts = config.type === "amount_off_products";
          const productGids = config.productIds.map((id) =>
            formatShopifyGid("Product", id),
          );
          const collectionGids = config.collectionIds.map((id) =>
            formatShopifyGid("Collection", id),
          );

          if (
            isProducts &&
            productGids.length > 0 &&
            collectionGids.length > 0
          ) {
            throw new DiscountProviderError(
              "shopify",
              "INVALID_DISCOUNT_CONFIG",
              "Amount off products scope must contain products or collections, not both.",
            );
          }

          const items =
            isProducts && (productGids.length > 0 || collectionGids.length > 0)
              ? {
                  ...(productGids.length > 0
                    ? { products: { productsToAdd: productGids } }
                    : {}),
                  ...(collectionGids.length > 0
                    ? { collections: { collectionsToAdd: collectionGids } }
                    : {}),
                }
              : { all: true };

          const data =
            await requestShopify<ShopifyDiscountCodeBasicCreateResponse>({
              shopifyStoreId: credentials.shop,
              accessToken: credentials.accessToken!,
              query: /* GraphQL */ `
                mutation DiscountCodeBasicCreate(
                  $basicCodeDiscount: DiscountCodeBasicInput!
                ) {
                  discountCodeBasicCreate(
                    basicCodeDiscount: $basicCodeDiscount
                  ) {
                    codeDiscountNode {
                      id
                      codeDiscount {
                        ... on DiscountCodeBasic {
                          codes(first: 1) {
                            nodes {
                              code
                            }
                          }
                        }
                      }
                    }
                    userErrors {
                      field
                      message
                      code
                    }
                  }
                }
              `,
              variables: {
                basicCodeDiscount: {
                  title: `Dub Discount (${currentCode})`,
                  code: currentCode.toUpperCase(),
                  startsAt: new Date().toISOString(),
                  customerSelection: { all: true },
                  appliesOncePerCustomer: true,
                  customerGets: {
                    items,
                    appliesOnOneTimePurchase: true,
                    appliesOnSubscription: true,
                    value:
                      discount.type === "percentage"
                        ? { percentage: discount.amount / 100 }
                        : {
                            discountAmount: {
                              amount: (discount.amount / 100).toFixed(2),
                              appliesOnEachItem: false,
                            },
                          },
                  },
                  recurringCycleLimit,
                },
              },
            });

          responseNode = data.discountCodeBasicCreate;
        }

        const { codeDiscountNode, userErrors } = responseNode;

        if (userErrors && userErrors.length > 0) {
          throw new ShopifyAdminGraphqlError(
            userErrors[0].code || "user_error",
            userErrors[0].message,
            userErrors,
          );
        }

        if (!codeDiscountNode) {
          throw new ShopifyAdminGraphqlError(
            "no_node_returned",
            "Shopify did not return a discount code. Please try again.",
          );
        }

        return {
          code: codeDiscountNode.codeDiscount.codes.nodes[0].code,
        };
      } catch (error) {
        if (error instanceof DiscountProviderError) {
          throw error;
        }

        const isDuplicate =
          error instanceof ShopifyAdminGraphqlError &&
          (error.code === "TAKEN" ||
            error.code === "DUPLICATE" ||
            /taken|duplicate|already exists/i.test(error.message));

        if (isDuplicate) {
          if (!shouldRetry) {
            throw new DiscountProviderError(
              "shopify",
              "DISCOUNT_ALREADY_EXISTS",
              `The discount code ${currentCode} is already in use. Please choose a different code.`,
            );
          }

          attempt++;

          if (attempt >= MAX_ATTEMPTS) {
            throw new DiscountProviderError(
              "shopify",
              "CREATE_FAILED",
              `Failed to create a unique discount code after ${MAX_ATTEMPTS} attempts. Please try again.`,
            );
          }

          const newCode = `${currentCode}${nanoid(2)}`;

          console.warn(
            `Discount code "${currentCode}" already exists in Shopify. Retrying with "${newCode}" (attempt ${attempt}/${MAX_ATTEMPTS}).`,
          );

          currentCode = newCode;
          continue;
        }

        if (error instanceof ShopifyAdminGraphqlError) {
          throwIfShopifyUnauthorized(error);

          throw new DiscountProviderError(
            "shopify",
            "CREATE_FAILED",
            error.code === "no_node_returned"
              ? "Shopify did not return a discount code. Please try again."
              : error.code === "http_error" || error.code === "graphql_error"
                ? `Unable to create the discount code in Shopify. ${error.message}`
                : error.message,
          );
        }

        throw new DiscountProviderError(
          "shopify",
          "CREATE_FAILED",
          error instanceof Error
            ? error.message
            : "Failed to create Shopify discount code.",
        );
      }
    }

    throw new DiscountProviderError(
      "shopify",
      "CREATE_FAILED",
      "Failed to create Shopify discount code.",
    );
  };

  const disableDiscountCode = async ({
    workspace,
    code,
  }: {
    workspace: Pick<Project, "id" | "shopifyStoreId">;
    code: string;
  }) => {
    const installation = await requireShopifyCredential(workspace);
    const { credentials } = installation;
    const requestShopify = <T>(
      options: Parameters<typeof shopifyAdminGraphql>[0],
    ) =>
      shopifyAdminGraphql<T>({
        ...options,
        ...("nativeStore" in installation ? { allowSdkFallback: false } : {}),
      });
    const targetShop = credentials.shop || workspace.shopifyStoreId || "";
    const targetToken = credentials.accessToken || "";

    try {
      const lookup = await requestShopify<{
        codeDiscountNodeByCode: {
          id: string;
          codeDiscount?: {
            title?: string;
            codes?: {
              nodes?: Array<{
                id: string;
                code: string;
              }>;
            };
          };
        } | null;
      }>({
        shopifyStoreId: targetShop,
        accessToken: targetToken,
        query: /* GraphQL */ `
          query CodeDiscountNodeByCode($code: String!) {
            codeDiscountNodeByCode(code: $code) {
              id
              codeDiscount {
                ... on DiscountCodeBasic {
                  title
                  codes(first: 50) {
                    nodes {
                      id
                      code
                    }
                  }
                }
                ... on DiscountCodeBxgy {
                  title
                  codes(first: 50) {
                    nodes {
                      id
                      code
                    }
                  }
                }
                ... on DiscountCodeFreeShipping {
                  title
                  codes(first: 50) {
                    nodes {
                      id
                      code
                    }
                  }
                }
                ... on DiscountCodeApp {
                  title
                  codes(first: 50) {
                    nodes {
                      id
                      code
                    }
                  }
                }
              }
            }
          }
        `,
        variables: { code },
      });

      const id = lookup.codeDiscountNodeByCode?.id;

      if (!id) {
        console.warn(
          `Shopify discount code ${code} not found (shopifyStoreId=${targetShop}).`,
        );
        return;
      }

      const codes =
        lookup.codeDiscountNodeByCode?.codeDiscount?.codes?.nodes ?? [];
      const matchingCodeNode = codes.find(
        (c) => c.code.toUpperCase() === code.toUpperCase(),
      );

      // If code is inside a multi-code bulk parent discount node, delete only the redeem code
      if (codes.length > 1 && matchingCodeNode?.id) {
        const bulkDeleteData = await requestShopify<{
          discountCodeRedeemCodeBulkDelete: {
            job?: { id: string; done: boolean } | null;
            userErrors: Array<{
              field: string[];
              message: string;
              code?: string;
            }>;
          };
        }>({
          shopifyStoreId: targetShop,
          accessToken: targetToken,
          query: /* GraphQL */ `
            mutation DeleteRedeemCode($discountId: ID!, $ids: [ID!]!) {
              discountCodeRedeemCodeBulkDelete(
                discountId: $discountId
                ids: $ids
              ) {
                job {
                  id
                  done
                }
                userErrors {
                  field
                  message
                  code
                }
              }
            }
          `,
          variables: {
            discountId: id,
            ids: [matchingCodeNode.id],
          },
        });

        const userErrors =
          bulkDeleteData.discountCodeRedeemCodeBulkDelete?.userErrors ?? [];
        if (userErrors.length > 0) {
          throw new ShopifyAdminGraphqlError(
            userErrors[0].code || "user_error",
            userErrors[0].message,
            userErrors,
          );
        }

        console.info(
          `Deleted Shopify redemption code ${code} (codeId=${matchingCodeNode.id}, parentId=${id}, shopifyStoreId=${targetShop}).`,
        );

        return {
          id: matchingCodeNode.id,
          code,
        };
      }

      // Otherwise delete standalone discount node
      const data = await requestShopify<{
        discountCodeDelete: ShopifyDiscountCodeDelete;
      }>({
        shopifyStoreId: targetShop,
        accessToken: targetToken,
        query: /* GraphQL */ `
          mutation DiscountCodeDelete($id: ID!) {
            discountCodeDelete(id: $id) {
              deletedCodeDiscountId
              userErrors {
                field
                message
                code
              }
            }
          }
        `,
        variables: { id },
      });

      const { userErrors } = data.discountCodeDelete;

      if (userErrors.length > 0) {
        throw new ShopifyAdminGraphqlError(
          userErrors[0].code,
          userErrors[0].message,
          userErrors,
        );
      }

      console.info(
        `Deleted Shopify discount code ${code} (id=${id}, shopifyStoreId=${targetShop}).`,
      );

      return {
        id,
        code,
      };
    } catch (error) {
      throwIfShopifyUnauthorized(error);
      throw error;
    }
  };

  const assertDiscountIntegration = async ({
    workspace,
  }: {
    workspace: Pick<Project, "id" | "stripeConnectId" | "shopifyStoreId">;
  }) => {
    await requireShopifyCredential(workspace);
  };

  return {
    getCoupon,
    createCoupon,
    createDiscountCode,
    disableDiscountCode,
    assertDiscountIntegration,
  };
}

export const shopifyDiscountProvider = createShopifyDiscountProvider();
