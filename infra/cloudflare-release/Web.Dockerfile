# Candidate web/outbox recipes. No upload, provisioning or deployment.
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

FROM dependencies AS source
COPY apps/web apps/web
COPY packages packages
COPY turbo.json ./
COPY infra/cloudflare-release infra/cloudflare-release
RUN --network=none pnpm turbo build --filter=web^...
RUN --network=none pnpm --filter web exec prisma generate --schema=./prisma/schema

FROM source AS runtime-dependencies
# Keep the web workspace graph, including tsx used by the outbox entrypoint,
# without copying unrelated root workspace dependencies into either image.
RUN --mount=type=cache,id=weletic-cloudflare-release-pnpm,target=/pnpm/store \
    pnpm --frozen-lockfile --store-dir /pnpm/store --filter web deploy /opt/web-runtime
RUN --network=none cd /opt/web-runtime && pnpm exec prisma generate --schema=./prisma/schema

FROM source AS web-build
RUN --network=none mkdir -p /opt/weletic-release-build && node infra/cloudflare-release/web-build.mjs

# Fresh runtime: no builder ENV and no synthetic provider values.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && apt-get clean
WORKDIR /workspace
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=runtime-dependencies /opt/web-runtime/node_modules ./apps/web/node_modules
COPY --from=runtime-dependencies /opt/web-runtime/package.json ./apps/web/package.json
COPY --from=source /workspace/packages ./packages
COPY infra/cloudflare-release/start.mjs infra/cloudflare-release/runtime-policy.mjs infra/cloudflare-release/billing-policy.mjs ./infra/cloudflare-release/
USER node
STOPSIGNAL SIGTERM

FROM runtime AS web
COPY --from=web-build /workspace/apps/web/.next ./apps/web/.next
COPY apps/web/next.config.js ./apps/web/next.config.js
COPY apps/web/public ./apps/web/public
COPY infra/cloudflare-release/loyalty-web.mjs infra/cloudflare-release/loyalty-routes.mjs ./infra/cloudflare-release/
EXPOSE 3000
ENTRYPOINT ["node", "/workspace/infra/cloudflare-release/start.mjs", "web"]

FROM runtime AS outbox
# TSX worker keeps workspace aliases and source imports; no compiled Next output.
COPY apps/web/tsconfig.json ./apps/web/tsconfig.json
COPY apps/web/lib ./apps/web/lib
COPY apps/web/ui ./apps/web/ui
COPY apps/web/scripts/loyalty ./apps/web/scripts/loyalty
COPY apps/web/scripts/runtime ./apps/web/scripts/runtime
ENTRYPOINT ["node", "/workspace/infra/cloudflare-release/start.mjs", "outbox"]
