# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /opt/cardbush
COPY . .
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN npm ci --ignore-scripts && npm run build:agent && npm run build:web:ui

FROM node:24-bookworm-slim AS web
WORKDIR /opt/cardbush
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini git python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1100 --shell /bin/bash cardbush \
    && mkdir -p /data && chown cardbush:cardbush /data
RUN python3 -m venv /opt/cardbush-python && /opt/cardbush-python/bin/pip install --no-cache-dir 'mcp>=1.28,<2' 'httpx==0.28.1' 'pydantic>=2.13,<3' 'Pillow>=10,<13'
COPY --from=build /opt/cardbush /opt/cardbush
ENV NODE_ENV=production HOME=/home/cardbush
USER 1100:1100
ENTRYPOINT ["/usr/bin/tini", "--", "node"]
CMD ["dist-electron/webServer.mjs"]
