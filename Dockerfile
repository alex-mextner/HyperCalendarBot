ARG BUN_VERSION=1.3.11

# Stage 1: install all deps (dev + prod) — needed for playwright install-deps
FROM debian:bookworm-slim AS deps
WORKDIR /app
ARG BUN_VERSION
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" && \
    rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --ignore-scripts

# Stage 2: production deps only (no devDependencies)
FROM debian:bookworm-slim AS prod-deps
WORKDIR /app
ARG BUN_VERSION
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" && \
    rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --production --ignore-scripts

# Stage 3: final image
FROM debian:bookworm-slim AS runner
WORKDIR /app
ARG BUN_VERSION
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" && \
    rm -rf /var/lib/apt/lists/*

RUN ln -s /usr/local/bin/bun /usr/local/bin/node

# Install only system libraries required by Chromium (not the browser itself).
# The Chromium binary is mounted from the host via docker-compose volume.
# Playwright CLI is needed only for install-deps — use full node_modules from deps stage.
COPY --from=deps /app/node_modules ./node_modules
RUN ./node_modules/.bin/playwright install-deps chromium

# Replace with production node_modules (no devDependencies)
RUN rm -rf ./node_modules
COPY --from=prod-deps /app/node_modules ./node_modules

COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json bunfig.toml ./

RUN groupadd -r botuser && useradd -r -g botuser botuser && \
    mkdir -p logs data && \
    chown -R botuser:botuser /app

USER botuser

EXPOSE 3311
CMD ["bun", "run", "start"]
