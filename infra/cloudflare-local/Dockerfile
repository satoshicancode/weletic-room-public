# Local compatibility image only. No registry upload or production release.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS dependency-install
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
RUN --mount=type=cache,id=weletic-cloudflare-local-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM dependency-install AS dependencies
RUN mkdir -p /opt/weletic-local-probe
COPY apps/web apps/web
COPY packages packages
COPY turbo.json ./
RUN --network=none pnpm turbo build --filter=web^...
RUN --network=none pnpm --filter web exec prisma generate --schema=./prisma/schema

FROM dependencies AS shopify-build
RUN --network=none WELETIC_LOCAL_CONTAINER_BUILD=1 pnpm --filter @weletic/shopify-app build

FROM shopify-build AS shopify
COPY infra/cloudflare-local infra/cloudflare-local
USER node
EXPOSE 3000
ENTRYPOINT ["node", "/workspace/infra/cloudflare-local/probe.mjs"]
CMD ["shopify"]

FROM dependencies AS worker
COPY infra/cloudflare-local infra/cloudflare-local
USER node
ENTRYPOINT ["node", "/workspace/infra/cloudflare-local/probe.mjs"]
CMD ["worker"]

FROM dependencies AS web-build
COPY infra/cloudflare-local/probe.mjs infra/cloudflare-local/probe.mjs
RUN --network=none node infra/cloudflare-local/probe.mjs build-web

FROM web-build AS web
COPY infra/cloudflare-local infra/cloudflare-local
USER node
EXPOSE 3000
ENTRYPOINT ["node", "/workspace/infra/cloudflare-local/probe.mjs"]
CMD ["web"]
