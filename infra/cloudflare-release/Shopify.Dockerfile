# Candidate Shopify release recipe. No deployment or image upload is authorized.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates git \
    && apt-get clean && corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/embeds/core/package.json packages/embeds/core/package.json
COPY packages/embeds/react/package.json packages/embeds/react/package.json
COPY packages/hubspot-app/package.json packages/hubspot-app/package.json
COPY packages/shopify-app/package.json packages/shopify-app/package.json
COPY packages/shopify-app/extensions/weletic-free-product/package.json packages/shopify-app/extensions/weletic-free-product/package.json
COPY packages/stripe-app/package.json packages/stripe-app/package.json
COPY packages/tailwind-config/package.json packages/tailwind-config/package.json
COPY packages/tinybird/package.json packages/tinybird/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/utils/package.json packages/utils/package.json
ENV CI=true NEXT_TELEMETRY_DISABLED=1 DOTENV_FLOW_SILENT=true
RUN --mount=type=cache,id=weletic-cloudflare-release-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM dependencies AS runtime-dependencies
# Resolve only the Shopify production graph before application source is copied.
RUN --mount=type=cache,id=weletic-cloudflare-release-pnpm,target=/pnpm/store \
    pnpm --frozen-lockfile --store-dir /pnpm/store --filter @weletic/shopify-app deploy --prod /opt/shopify-runtime

FROM dependencies AS build
COPY apps/web apps/web
COPY packages packages
COPY turbo.json ./
RUN --network=none pnpm turbo build --filter=web^...
RUN --network=none pnpm --filter web exec prisma generate --schema=./prisma/schema
RUN --network=none WELETIC_SHOPIFY_BUILD_TARGET=node pnpm --filter @weletic/shopify-app build

# Do not inherit build-time flags, synthetic probe configuration or source trees.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS shopify
WORKDIR /workspace
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 HOSTNAME=0.0.0.0
COPY --from=runtime-dependencies /opt/shopify-runtime/node_modules ./packages/shopify-app/node_modules
COPY --from=build /workspace/packages/shopify-app/package.json ./packages/shopify-app/package.json
COPY --from=build /workspace/packages/shopify-app/build ./packages/shopify-app/build
COPY packages/shopify-app/app/public-runtime-policy.mjs packages/shopify-app/app/preview-origins.mjs ./packages/shopify-app/app/
COPY infra/cloudflare-release/start.mjs infra/cloudflare-release/runtime-policy.mjs ./infra/cloudflare-release/
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/workspace/infra/cloudflare-release/start.mjs", "shopify"]
