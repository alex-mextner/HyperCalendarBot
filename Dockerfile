ARG BUN_VERSION=1.3.11

# Stage 1: install deps with locked versions
FROM debian:bookworm-slim AS prod-deps
WORKDIR /app
ARG BUN_VERSION
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" && \
    rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
# bun.lock pins exact versions (playwright revision must match installed browser).
# --production is omitted: bun rewrites lockfile format with --production, breaking
# --frozen-lockfile. DevDeps are tiny (biome, types, lefthook, pino-pretty).
RUN bun install --ignore-scripts

# Stage 2: final image
FROM debian:bookworm-slim AS runner
WORKDIR /app
ARG BUN_VERSION
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates python3 python3-venv && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" && \
    curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && \
    rm -rf /var/lib/apt/lists/*

RUN ln -s /usr/local/bin/bun /usr/local/bin/node

# Python venv — pyrogram-only deps for birthday/username/message scripts.
# Heavy deps (torch, ntgcalls, silero) run on host, not in container.
COPY requirements.docker.txt ./
RUN python3 -m venv venv && \
    uv pip install --no-cache-dir -r requirements.docker.txt --python venv/bin/python

# Locked node_modules from prod-deps stage
COPY --from=prod-deps /app/node_modules ./node_modules

# Chromium headless shell — only the headless binary, not the full browser.
# Playwright 1.58+ uses chromium-headless-shell for headless mode by default.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN ./node_modules/.bin/playwright install --with-deps chromium-headless-shell

COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json bunfig.toml package.json ./

RUN groupadd -r botuser && useradd -r -g botuser botuser && \
    mkdir -p logs data && \
    chown -R botuser:botuser /app

USER botuser

EXPOSE 3311
CMD ["bun", "run", "start"]
