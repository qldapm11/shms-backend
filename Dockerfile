# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Generate Prisma Client
RUN npx prisma generate

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install production dependencies only
RUN npm ci --omit=dev

# Generate Prisma Client
RUN npx prisma generate

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy wiki content (should be copied into backend dir before build)
COPY wiki-content /wiki-content

# Copy frontend build (will be mounted or copied separately)
RUN mkdir -p public

# Initialize database directory
RUN mkdir -p /data

# Environment variables (override at runtime)
ENV NODE_ENV=production
ENV PORT=3010
ENV BASE_PATH=/shms

# Expose port
EXPOSE 3010

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3010/shms/api/v1/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Start application
ENTRYPOINT ["/docker-entrypoint.sh"]
