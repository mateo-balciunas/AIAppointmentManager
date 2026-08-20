# =============================================================================
# Stage 1: Builder - Install dependencies and compile Typescript
# =============================================================================
FROM node:20-alpine AS builder

WORKDIR /build

# Copy dependency files first
COPY package.json package-lock.json* ./

# Install all dependencies (devDependencies included to compile TS)
RUN npm ci

# Copy source code
COPY . .

# Compile Typescript to JavaScript
RUN npm run build

# =============================================================================
# Stage 2: Runner - Final image optimized for production
# =============================================================================
FROM node:20-alpine AS runner

# Install necessary tools for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Only copy production dependencies from builder
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && cache clean --force

# Copy compiled code from builder
COPY --from=builder /build/dist ./dist

# User without privileges
USER node

# Intern service port
EXPOSE 8080

# Startup command
CMD ["node", "dist/idex.js"] 