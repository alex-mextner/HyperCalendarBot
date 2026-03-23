FROM oven/bun:1-debian
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --ignore-scripts

# Install chromium + all system dependencies required by playwright
RUN ./node_modules/.bin/playwright install --with-deps chromium

# curl is needed for Docker healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json bunfig.toml ./

EXPOSE 3311
CMD ["bun", "run", "start"]
