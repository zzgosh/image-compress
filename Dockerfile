FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV IMAGE_COMPRESS_API_PORT=3001

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

EXPOSE 3001
CMD ["node", "dist/server.js"]
