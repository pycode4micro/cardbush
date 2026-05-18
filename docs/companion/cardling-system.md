# Cardling Companion System

Reference sheet: `cardling-concepts.png`

## Direction

Cardling is a compact desktop companion for CardBush. It should feel like a
small status object from the app itself, not a separate character layered on
top of the product. The base silhouette is a rounded card with a tiny leaf,
soft status eyes, and subtle motion.

## Visual Rules

- Keep the shape simple enough to render in CSS, SVG, Lottie, or Rive.
- Use the app accent color for glow and active states.
- Prefer small motion loops over expressive full-body animation.
- Avoid blocking the chat surface. The badge stays fixed near the lower-right
  edge and opens into a compact status panel.

## Status Map

| Status | Meaning | Visual cue |
|---|---|---|
| idle | Ready | slow breathing |
| thinking | Assistant is generating | alternating eye pulse |
| tool | Tool or file operation is running | scan line and cursor mark |
| waiting | User input or choice is needed | warm leaf highlight |
| queued | User message is queued | stacked card offset and count badge |
| complete | Assistant turn finished | short sparkle feedback |
| error | Action failed | red corner signal |

## First Implementation

- Main app fallback component: `src/App.tsx` (`CardlingCompanion`)
- Desktop floating window component: `src/CardlingWindow.tsx`
- Desktop window owner: `electron/main.ts` (`createCardlingWindow`)
- Style: `src/styles/app.css` (`.cardling-*`)
- Setting: Settings -> Cardling
- Inputs: sending state, queued message count, pending interaction, running tool
  state, change count, and error state.
- Behavior: Electron creates a transparent, frameless, always-on-top Cardling
  window. The badge can be dragged to a preferred desktop position and persists
  that position in app user data.
- Actions: when a chat has file diffs, the panel can open the chat diff dialog
  or trigger the existing reverse-diff revert-all flow.
- Preferences: visibility, size, opacity, motion level, and reset-position
  controls live in a dedicated Cardling settings page.
- Completion feedback: the companion briefly enters `complete` after an
  assistant turn finishes without an error.
- Status event map: the settings page lists each status, its trigger, and its
  visual cue for easier future wiring to richer animation assets.

## IPC Boundary

- Main app sends `cardling:update-state` with the current Cardling state.
- Desktop window receives `cardling:state`.
- Desktop window sends `cardling:action` for settings, diff, and revert actions.
- Desktop window sends `cardling:set-expanded` and `cardling:move-by` for panel
  sizing and drag movement.
- Main app can send `cardling:reset-position` from the Cardling settings page.

## Next Steps

- Export the CSS shape as an SVG fallback for tray/about screens.
- Replace CSS motion with Rive or Lottie only if the interaction model needs
  richer transitions.
