# Welcome suggestions and star wordmark

The empty conversation view displays a canvas `cardbush` wordmark and three
editable starting prompts. Selecting a suggestion fills and focuses the composer;
it never sends a message or replaces a nonempty draft.

## History boundary

`runtime.list_user_prompts` is a read-only journal projection. The welcome view
requests the preceding seven rolling days, across normal user conversations.
It uses message timestamps, excludes hidden/child sessions, internal and named
continuation messages, automated prompts, and superseded user messages. Explicit
reference expansion is removed using the existing `composerReferenceContent`
metadata. Tool/assistant payloads and attachment contents do not cross this API.

The request returns at most 1,200 recent prompts (protocol maximum 2,000), with
4,000 characters per prompt and an explicit truncation flag. This bounds transfer
and ranking work for unusually large histories. It reads the canonical journal;
it does not create an experience store, update history, inject suggestions into a
model prompt, or invoke an LLM. Recommendations are refreshed on entering welcome
and returning to a visible window, with a one-minute refresh minimum.

## Ranking and fallbacks

Ranking is extractive: segment Chinese/English prose, count terms once per
distinct prompt, rank complete source sentences by frequent terms and recency,
then penalize overlapping topics. Common filler, code, quoted source blocks,
paths, URLs and reference tokens are excluded. ICU single-character Chinese
splits get adjacent-character recovery without a project-specific vocabulary.
Suggestions keep the language and wording of their source; they are not LLM
rewrites. When history is missing, unavailable, or insufficient, clearly marked
generic starting prompts complete the three slots.

## Rendering

Four-point stars, diamonds and small dots form a text mask. Local date and time
select a smoothly changing palette with separate contrast for light themes.
The `d` and `b` particles keep a white accent in dark themes and a near-black
accent in light themes, including while they move.
Pointer proximity disperses the stars, holding the primary mouse button draws
them together, and leaving reassembles the word. Touch scrolling is unaffected.
The canvas caps DPR at 2 and animation at 30 fps, pauses when hidden/offscreen,
renders a still image for reduced motion, and removes observers, animation and
timers on unmount. Narrow windows stack the prompts while keeping the composer
available.

Switching project/task mode resolves the destination conversation in the same
React event. It does not clear selection and mount an intermediate empty composer
before the scope reconciliation effect selects a draft. Existing scoped text
drafts stay independent, and a missing scope prepares one in-memory draft.

## Verification

- `node --test scripts/test-welcome-suggestions.mjs`: canonical history, time
  boundaries, supersession, frequency/diversity, retries, source contamination,
  fallback and date/time palette.
- `node scripts/run-welcome-ui.mjs`: isolated actual React/Chromium views;
  history loading, draft preservation/focus, dark/light/narrow layout, pointer
  reassembly, reduced motion, visibility and unmount cleanup. No product profile
  or model is used. Screenshots are saved under `tmp/welcome-redesign-*.png`.
- Build protocol and Runtime before running history tests.
