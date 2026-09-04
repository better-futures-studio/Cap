FROM node:24-alpine AS base
RUN corepack enable

FROM base AS builder
WORKDIR /app
COPY . .

RUN corepack enable pnpm
RUN --mount=type=cache,id=s/4eb09acd-47d5-4f5b-9028-dfd7185f94ad-pnpm,target=/root/.local/share/pnpm/store pnpm i --frozen-lockfile

ARG NEXT_PUBLIC_DOCKER_BUILD=true
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_WEB_URL=http://localhost:3000
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN

RUN pnpm run build:web


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


USER nextjs

EXPOSE 3000

CMD HOSTNAME="::" node apps/web/server.js
