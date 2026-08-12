# Stage 1: Build stage with all dependencies
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Stage 2: Production runner
FROM node:20-alpine AS runner
WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 vcp
USER vcp

# Copy node_modules from builder stage (includes tsx for runtime)
COPY --from=builder --chown=vcp:nodejs /app/node_modules ./node_modules

# Copy source files from builder stage
COPY --from=builder --chown=vcp:nodejs /app/src ./src
COPY --from=builder --chown=vcp:nodejs /app/index_16.ts ./
COPY --from=builder --chown=vcp:nodejs /app/index_201.ts ./
COPY --from=builder --chown=vcp:nodejs /app/index_21.ts ./
COPY --from=builder --chown=vcp:nodejs /app/package.json ./
# The fleet-controller (spawns/supervises N of this same image's VCP
# entrypoints as sibling processes, plus its own web UI) - an alternate
# ENTRY_POINT for this same image, not a separate one.
COPY --from=builder --chown=vcp:nodejs /app/fleet-controller ./fleet-controller

# Environment variables
ENV ENTRY_POINT=index_16.ts
ENV ADMIN_PORT=9999
# Only read when ENTRY_POINT=fleet-controller/server.ts.
ENV CONTROLLER_PORT=8787

# Admin API port (single-VCP mode) and fleet-controller port (fleet mode) -
# only one applies at a time depending on ENTRY_POINT, harmless to expose both.
EXPOSE 9999 8787

# Run the application - local tsx binary, not npx, so startup doesn't touch
# the npm registry at all inside the container.
CMD ["sh", "-c", "./node_modules/.bin/tsx ${ENTRY_POINT}"]
