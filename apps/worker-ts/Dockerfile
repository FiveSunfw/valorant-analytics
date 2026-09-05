FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api-ts/package.json apps/api-ts/package.json
COPY apps/migrate-ts/package.json apps/migrate-ts/package.json
COPY apps/worker-ts/package.json apps/worker-ts/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN npm ci --ignore-scripts
COPY apps/worker-ts apps/worker-ts
COPY packages/domain packages/domain
RUN npm run build --workspace=@valorant/domain && npm run build --workspace=@valorant/worker

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/worker-ts/package.json ./apps/worker-ts/package.json
COPY --from=build /app/apps/worker-ts/dist ./apps/worker-ts/dist
COPY --from=build /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
CMD ["node", "apps/worker-ts/dist/main.js"]
