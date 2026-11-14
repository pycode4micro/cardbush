# Build from an isolated copy of the NAS base release with skill-routing-20261114.patch applied.
FROM cardbush-web:runtime-loop-20261114
COPY --chown=cardbush:cardbush assets/skills/auto-video-slicing/SKILL.md /opt/cardbush/assets/skills/auto-video-slicing/SKILL.md
