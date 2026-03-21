FROM oven/bun:1-debian
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Install chromium + all system dependencies required by playwright
RUN ./node_modules/.bin/playwright install --with-deps chromium

COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json bunfig.toml ./

EXPOSE 3311
CMD ["bun", "run", "start"]
