# Apply material-review-20261114.patch to an isolated copy of the deployed skill before building.
FROM cardbush-web:skill-routing-20261114
COPY --chown=cardbush:cardbush assets/skills/auto-video-slicing/SKILL.md /opt/cardbush/assets/skills/auto-video-slicing/SKILL.md
