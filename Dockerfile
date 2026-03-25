FROM debian:bookworm-slim
WORKDIR /app

# Install bun — version pinned to match lockfile
ARG BUN_VERSION=1.3.11
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" && \
    rm -rf /var/lib/apt/lists/*

# bun install respects lockfile version pins; --frozen-lockfile is validated
# in CI (same platform). Docker adjusts only platform-specific optional deps.
COPY package.json bun.lock ./
RUN ln -s /usr/local/bin/bun /usr/local/bin/node
RUN bun install --ignore-scripts

# Install only system libraries required by Chromium (not the browser itself).
# The Chromium binary is mounted from the host via docker-compose volume.
RUN ./node_modules/.bin/playwright install-deps chromium

# curl already installed above
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json bunfig.toml ./

RUN groupadd -r botuser && useradd -r -g botuser botuser && \
    mkdir -p logs data && \
    chown -R botuser:botuser /app

USER botuser

EXPOSE 3311
CMD ["bun", "run", "start"]
