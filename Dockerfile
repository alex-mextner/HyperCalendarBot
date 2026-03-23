FROM debian:bookworm-slim
WORKDIR /app

# Install bun — version pinned to match lockfile
ARG BUN_VERSION=1.3.11
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" && \
    rm -rf /var/lib/apt/lists/*

# Lockfile pins all versions; --frozen-lockfile is impossible cross-platform
# (macOS arm64 lockfile ≠ linux amd64 due to platform-specific optional deps)
COPY package.json bun.lock ./
RUN bun install --production

# Install chromium + all system dependencies required by playwright
RUN ./node_modules/.bin/playwright install --with-deps chromium

# curl already installed above
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json bunfig.toml ./

EXPOSE 3311
CMD ["bun", "run", "start"]
