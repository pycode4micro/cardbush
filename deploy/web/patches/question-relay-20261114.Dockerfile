FROM cardbush-web:runtime-loop-20261114
USER root
WORKDIR /opt/cardbush
COPY electron/ electron/
COPY web/ web/
COPY src/ src/
COPY scripts/ scripts/
RUN npm run build --workspace @cardbush/platform && node node_modules/typescript/bin/tsc -p tsconfig.node.json
RUN cp -a dist-web /tmp/old-web && mv packages/bush-protocol/dist /tmp/runtime-protocol && cp -a .web-renderer-protocol packages/bush-protocol/dist && npm run build:web:ui && cp -an /tmp/old-web/assets/. dist-web/assets/ && mv packages/bush-protocol/dist /tmp/renderer-protocol-used && mv /tmp/runtime-protocol packages/bush-protocol/dist
USER 1100:1100
