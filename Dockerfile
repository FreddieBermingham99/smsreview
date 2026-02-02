# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Run stage
FROM node:20-alpine

WORKDIR /app

# Copy built app and production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Create data dir for SQLite (opt-outs) and uploads; can override with volume
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 4010

# PORT is set by Railway/Render etc.; we fall back to 4010 in config
CMD ["node", "dist/index.js"]
