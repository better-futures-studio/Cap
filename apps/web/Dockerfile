FROM node:24-alpine AS base
RUN corepack enable

FROM base AS builder
WORKDIR /app
COPY . .

RUN corepack enable pnpm
# No pnpm store cache mount: Railway requires the cache id to name the building
# service literally, and this Dockerfile builds for more than one instance.
RUN pnpm i --frozen-lockfile

ARG NEXT_PUBLIC_DOCKER_BUILD=true
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_WEB_URL=http://localhost:3000
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN

# Turbopack occasionally fails loading postcss.config.js; a second run passes.
RUN pnpm run build:web || pnpm run build:web


# 3. Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001


# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/packages/database/migrations ./apps/web/migrations
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/workflow-worker.mjs ./apps/web/workflow-worker.mjs
# The workflow runtime loads its world by package name at runtime, which
# Next's file tracing cannot follow. Install the Postgres world with its own
# dependency tree beside the app and expose it through NODE_PATH.
RUN mkdir -p /app/workflow-world && cd /app/workflow-world \
	&& npm init -y > /dev/null \
	&& npm install --no-package-lock --omit=dev --ignore-scripts \
		@workflow/world-postgres@4.3.0 graphile-worker@0.16.6 pg@8.20.0 \
	&& chown -R nextjs:nodejs /app/workflow-world
ENV NODE_PATH=/app/workflow-world/node_modules


USER nextjs

EXPOSE 3000

CMD HOSTNAME="::" node apps/web/server.js
