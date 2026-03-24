# Build stage: compile server + bundle client
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY server.ts tsconfig.server.json tsconfig.client.json ./
COPY public ./public

RUN npm run build

# Runtime: Node + production deps + artifacts only
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

USER node

EXPOSE 3005

CMD ["node", "dist/server.js"]
