# ── docs-deps ──────────────────────────────────────────────
FROM node:22-alpine AS base

FROM base AS deps
WORKDIR /app
COPY docs/package.json ./
RUN npm install --ignore-scripts

# ── docs-build ─────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY docs/ .
RUN npm rebuild esbuild lightningcss
RUN npm run build

# ── runner ────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/scripts/start-runtime.mjs ./start-runtime.mjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "start-runtime.mjs"]
