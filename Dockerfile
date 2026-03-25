FROM debian:bookworm-slim
WORKDIR /app

# Install bun — version pinned to match lockfile
ARG BUN_VERSION=1.3.11
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl unzip ca-certificates python3 python3-venv && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" && \
    rm -rf /var/lib/apt/lists/*

# Python venv — pyrogram-only deps for birthday/username/message scripts.
# Heavy deps (torch, ntgcalls, silero) run on host, not in container.
COPY requirements.docker.txt ./
RUN python3 -m venv venv && \
    venv/bin/pip install --no-cache-dir -r requirements.docker.txt

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

# Generate stress dictionary from OpenRussian if not mounted via volume
RUN apt-get update && apt-get install -y --no-install-recommends git && \
    git clone --depth 1 https://github.com/Badestrand/russian-dictionary /tmp/russian-dictionary && \
    bun scripts/generate-stress-dict.ts && \
    rm -rf /tmp/russian-dictionary && \
    apt-get purge -y git && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

EXPOSE 3311
CMD ["bun", "run", "start"]
