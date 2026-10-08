# gstack-browser-mcp: upstream gstack `browse` + our API/MCP/admin server, Linux containers only.
# Layers are ordered so the slow gstack install (~10 min) is cached until GSTACK_REF changes.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\n' > /etc/apt/apt.conf.d/80-retries \
    && apt-get update && apt-get install -y --no-install-recommends \
       git curl unzip xz-utils ca-certificates procps util-linux findutils fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (Playwright's installer) and Bun (pinned + checksum-verified, as upstream CI does).
ENV NODE_VERSION=22.20.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJ -C /usr/local --strip-components=1 --no-same-owner -f /tmp/node.tar.xz && rm /tmp/node.tar.xz \
    && rm -rf /usr/local/include /usr/local/share/doc /usr/local/share/man
ARG BUN_VERSION=1.4.2
ARG BUN_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
    && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp/bun && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip

# ---- upstream gstack at a pinned commit (no fork, unmodified) ----
ARG GSTACK_REF
RUN test -n "${GSTACK_REF}" || (echo "GSTACK_REF build arg is required (see .gstack-ref)" && exit 1)
RUN git clone --filter=blob:none https://github.com/garrytan/gstack.git /opt/gstack \
    && git -C /opt/gstack checkout --quiet "${GSTACK_REF}" \
    && rm -rf /opt/gstack/.git
WORKDIR /opt/gstack
RUN bun install --frozen-lockfile && rm -rf /root/.bun/install/cache
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN npx playwright install --with-deps chromium && chmod -R a+rX /opt/playwright-browsers \
    && rm -rf /var/lib/apt/lists/* /root/.npm
RUN bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
      browse/src/cli.ts --outfile browse/dist/browse \
    && chmod +x browse/dist/browse && chmod -R a+rX /opt/gstack

# ---- one Linux user per session slot (spike change 2): gsess01..gsess32, uid 20001..20032 ----
RUN for i in $(seq 1 32); do n=$(printf '%02d' "$i"); \
      useradd --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --uid $((20000 + i)) --user-group "gsess$n"; \
    done

# ---- our server ----
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production && rm -rf /root/.bun/install/cache
COPY src ./src
COPY LICENSE ./
ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="gstack-browser-mcp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${APP_VERSION}" \
      gstack.ref="${GSTACK_REF}"
ENV CONTAINER=1 GSTACK_TELEMETRY_OFF=1 GSTACK_SKIP_ASIDE=1 \
    BROWSE_BIN=/opt/gstack/browse/dist/browse DATA_DIR=/data KEYS_FILE=/config/keys.json \
    APP_VERSION=${APP_VERSION}
VOLUME /data
EXPOSE 8080 8081
# The server runs as root inside the container only to start each session as its own
# unprivileged user (runuser) and to wipe that user's files; browsers never run as root.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1
CMD ["bun", "src/index.ts"]
