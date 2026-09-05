FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api-ts/package.json apps/api-ts/package.json
COPY apps/migrate-ts/package.json apps/migrate-ts/package.json
COPY apps/worker-ts/package.json apps/worker-ts/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN npm ci --ignore-scripts
COPY apps/migrate-ts apps/migrate-ts
RUN npm run build --workspace=@valorant/migrate

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/migrate-ts/package.json ./apps/migrate-ts/package.json
COPY --from=build /app/apps/migrate-ts/dist ./apps/migrate-ts/dist
CMD ["node", "apps/migrate-ts/dist/main.js"]
