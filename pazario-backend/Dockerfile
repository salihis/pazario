# Build stage
FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
RUN npm ci

# Create a dummy .env for build (prevents missing env in tsc)
RUN echo "DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy_db" > .env
RUN echo "REDIS_URL=redis://localhost:6379" >> .env

# Copy source
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

# Generate Prisma client before TypeScript build
RUN npx prisma generate

# Build
RUN npm run build

# Runtime stage
FROM node:20-bookworm-slim

WORKDIR /app

# Install curl for health checks and OpenSSL for Prisma engines
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy package files for dependencies
COPY package*.json ./

# Install dependencies. Prisma CLI is needed at container startup for migrate deploy.
RUN npm ci

# Copy built application from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
COPY tsconfig.json ./tsconfig.json
COPY src ./src

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Expose port
EXPOSE 3000

# Start application
CMD ["node", "dist/index.js"]
