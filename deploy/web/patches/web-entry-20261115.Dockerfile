FROM cardbush-web:material-review-20261114
COPY --chown=cardbush:cardbush electron/agentService.mts /opt/cardbush/electron/agentService.mts
COPY --chown=cardbush:cardbush dist-electron/agentService.mjs /opt/cardbush/dist-electron/agentService.mjs
COPY --chown=cardbush:cardbush assets/prompts/web-remote-delegation.md /opt/cardbush/assets/prompts/web-remote-delegation.md
COPY --chown=cardbush:cardbush assets/prompts/web-restricted.md /opt/cardbush/assets/prompts/web-restricted.md
COPY --chown=cardbush:cardbush scripts/test-web-remote-agents.mjs /opt/cardbush/scripts/test-web-remote-agents.mjs
RUN node --check /opt/cardbush/dist-electron/agentService.mjs
