# CI test runner image with ffmpeg and Playwright pre-installed.
# Saves ~50s per CI run by avoiding apt-get + playwright install on every job.
#
# Rebuild when Playwright or Bun version changes:
#   gh workflow run ci-image.yml
#
# Or push changes to this file — the ci-image workflow triggers automatically.

ARG BUN_VERSION=1.3.11
ARG PLAYWRIGHT_VERSION=1.58.2

FROM debian:bookworm-slim

ARG BUN_VERSION
ARG PLAYWRIGHT_VERSION

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl unzip ca-certificates git ffmpeg && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" && \
    ln -s /usr/local/bin/bun /usr/local/bin/node && \
    rm -rf /var/lib/apt/lists/*

# Install Playwright Chromium + system deps.
# Uses bunx to avoid needing a project — installs the exact version pinned above.
RUN bunx playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium

WORKDIR /app
