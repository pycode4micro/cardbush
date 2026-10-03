# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /opt/cardbush
COPY . .
RUN npm ci --ignore-scripts && npm run build:agent

# Default service image has no X server, browser, Python worker or screen capture dependencies.
FROM node:22-bookworm-slim AS service-base
WORKDIR /opt/cardbush
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1100 --shell /bin/bash cardbush \
    && mkdir -p /data && chown cardbush:cardbush /data
COPY --from=build /opt/cardbush /opt/cardbush
ENV NODE_ENV=production HOME=/home/cardbush
USER cardbush
EXPOSE 4780
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist-electron/agentServiceCli.mjs"]
CMD ["--data-dir", "/data", "--host", "0.0.0.0"]

# Explicitly selected Personal Agent image. Chromium sandbox stays enabled.
FROM mcr.microsoft.com/playwright/python:v1.63.0-noble AS desktop
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-venv xvfb openbox tint2 xdotool xclip x11-utils xauth dbus-x11 git ca-certificates tini fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/desktop-venv \
    && /opt/desktop-venv/bin/pip install --no-cache-dir playwright==1.63.0 mss==10.1.0 Pillow==11.3.0 \
    && useradd --create-home --uid 1100 --shell /bin/bash cardbush \
    && mkdir -p /data && chown cardbush:cardbush /data
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=build /opt/cardbush /opt/cardbush
RUN chmod 755 /opt/cardbush/deploy/agent/desktop-entrypoint.sh
WORKDIR /opt/cardbush
ENV NODE_ENV=production HOME=/home/cardbush CARDBUSH_DESKTOP_PYTHON=/opt/desktop-venv/bin/python3 DISPLAY=:99
USER cardbush
EXPOSE 4780
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/cardbush/deploy/agent/desktop-entrypoint.sh"]
CMD ["--data-dir", "/data", "--host", "0.0.0.0"]

# Building without --target remains headless, even though the optional target exists above.
FROM service-base AS service
