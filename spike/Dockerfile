# P1 spike image: upstream gstack `browse` on Linux, nothing else.
# Mirrors upstream .github/docker/Dockerfile.ci, trimmed to what browse needs.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\n' > /etc/apt/apt.conf.d/80-retries \
    && apt-get update && apt-get install -y --no-install-recommends \
       git curl unzip xz-utils ca-certificates jq procps \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (Playwright's installer runs on it) and Bun (pinned + verified, same as upstream CI).
ENV NODE_VERSION=22.20.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJ -C /usr/local --strip-components=1 --no-same-owner -f /tmp/node.tar.xz && rm /tmp/node.tar.xz
ARG BUN_VERSION=1.4.2
RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
    && echo "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp/bun && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip && bun --version

# Upstream gstack at a pinned commit (no fork).
ARG GSTACK_REF=9a1dc81a2b96e7b74a15e5911175bc04de7659e9
RUN git clone --filter=blob:none https://github.com/garrytan/gstack.git /opt/gstack \
    && git -C /opt/gstack checkout --quiet "${GSTACK_REF}"
WORKDIR /opt/gstack
RUN bun install --frozen-lockfile

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN npx playwright install --with-deps chromium && chmod -R a+rX /opt/playwright-browsers \
    && apt-get install -y --no-install-recommends fonts-liberation && rm -rf /var/lib/apt/lists/*

# Only the browse CLI is needed; it starts browse/src/server.ts with bun at runtime.
RUN bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
      browse/src/cli.ts --outfile browse/dist/browse \
    && chmod +x browse/dist/browse

RUN useradd -m -s /bin/bash gstack
ENV CONTAINER=1 GSTACK_TELEMETRY_OFF=1 GSTACK_SKIP_ASIDE=1
USER gstack
WORKDIR /home/gstack
CMD ["sleep", "infinity"]
