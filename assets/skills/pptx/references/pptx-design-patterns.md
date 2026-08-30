# PPTX Design Patterns

## Quick Reference

| Field | Value |
|---|---|
| Label | Deck visual pattern catalog |
| Use when | Creating or substantially redesigning a deck from scratch after the story spine and deck profile are known |
| Gives you | Deck lock fields, slide visual type catalog, palettes, typography, reusable components, and variety gates |
| Not for | Reading/editing an existing deck, route control, or source/data validation |
| Pair with | `pptxgenjs.md` and `references/pptx-layout-constraints.md` |

Use this file only after the main skill has selected create-from-scratch or substantial redesign. It is a visual pattern catalog, not an execution route.


> Scope: The rules below apply when creating a deck from scratch or when no template or brand guidelines are provided. If a template or brand system exists, follow it first and only borrow from these ideas when they do not conflict.

**Don't create boring slides.** Plain bullets on a white background won't impress anyone.

---

### Step 0: Lock the Deck Before Touching Coordinates

Do not jump from raw content straight into `addText()`, `addShape()`, or `addChart()`.

If a template, reference deck, or brand guideline exists, extract its visual contract first and preserve it.
If no visual contract exists, create one here before laying out slide geometry.

### Deck Design Lock (Required)

Before writing any code, output this block and commit to it for the whole deck:

```text
DECK DESIGN LOCK
----------------
Theme intent:
Palette:
Font pair:
Dark/light rhythm:
Visual motif:
Motif placement:
Card/background treatment:
Banned defaults:
```

Rules:

1. `Theme intent` is one concrete direction, such as `midnight executive`, `warm policy editorial`, or `industrial systems briefing`. Do not use vague filler like `modern`, `clean`, or `professional` by itself.
2. `Palette` must name either one palette from this file or a custom set with `PRIMARY / ACCENT / NEUTRAL / TEXT_DARK / TEXT_LIGHT`. Generic default blue is banned unless the user or brand requires it.
3. `Font pair` must explicitly declare one display font and one body font. Do not leave typography implicit.
4. `Dark/light rhythm` must name which slide numbers or slide roles are dark. Cover, section dividers, and closing slides are dark by default.
5. `Visual motif` must be one reusable design move that can recur across the deck, such as split backgrounds, caption bars, vertical accent rails, cropped photo bands, or tinted icon circles. A motif is an element, not a mood word.
6. `Motif placement` must say where the motif appears in at least 3 slide situations.
7. `Card/background treatment` must explain how light slides avoid looking identical, for example alternating `white cards on NEUTRAL` and `NEUTRAL cards on white`.
8. `Banned defaults` must list the repetitive patterns to avoid for this deck, such as `blue title + white card + 3 equal columns` or `accent lines under titles`.

If the deck changes direction later, regenerate the full lock before changing slide layouts.

---

### Content-to-Layout Routing (Required)

Assign content intent before choosing coordinates. Layout follows semantics, not habit.

| Content intent | Default Visual Type | Why | Avoid |
|----------------|---------------------|-----|-------|
| Cover, closing, single-idea emphasis | TYPE 1 | Full-bleed focus and strong deck framing | Plain title + paragraph on white |
| Section transition, chapter opener | TYPE 2 | Creates rhythm break and hierarchy reset | Reusing a normal content slide as a divider |
| KPI, metric highlights, headline numbers | TYPE 3 | Large numbers and icon-led emphasis | Converting metrics into text cards |
| Case study, narrative detail, image-supported explanation | TYPE 4 or TYPE 7 | Combines evidence and commentary without card spam | Long bullets with a tiny thumbnail |
| Four-part framework, quadrant, 4-item analysis | TYPE 5 | Explicit 2x2 structure matches the content | Squeezing 4 concepts into 3 columns |
| Agenda, 3 pillars, 3-step process | TYPE 6 | Clean 3-part rhythm with summary option | Three generic cards with no progression |
| Four-step process, action strip, 4 learning points | TYPE 8 | Horizontal sequence reads as progression | Forcing 4 steps into numbered bullets |
| Tension, quote, challenge vs opportunity, contrast frame | TYPE 9 | Strong asymmetry prevents monotony | Yet another two-card comparison |
| Timeline, roadmap, milestone sequence | TYPE 10 | Time-ordered visual grammar | Card grid with dates pasted on top |
| Chart with short interpretation | TYPE 11 | Data stays visual; insight stays concise | Chart plus a wall of explanation text |

If the content does not fit one of these intents cleanly, reframe the slide. Do not fall back to a generic card layout just because the content arrived as bullets.

---

### Execution Checklist (Required)

1. Produce the `DECK DESIGN LOCK` before any coordinates or code.
2. Route every slide through the `Content-to-Layout Routing` table before assigning a Visual Type.
3. Assign Visual Types for every slide and verify no adjacent duplicates.
4. Mark which slides are dark vs light, then confirm both the dark rhythm and the card/background treatment variety.
5. Decide if each slide has a summary bar; if yes, reserve space first (content bottom <= `4.05"`).
6. Count content blocks per slide and confirm they do not exceed template limits.
7. Confirm all body text is >= 14pt and footer text is >= 10pt.
8. Confirm total shapes per slide < 30; simplify if exceeded.
9. Run the `VARIETY GATES` below. If any gate fails, revise the deck design lock or slide routing table before writing code.

---

### Output Deck Design Format (Required)

Before writing code, output a short deck design lock and routing table in this format:

```text
DECK DESIGN LOCK
Theme intent: midnight executive
Palette: Midnight Executive
Font pair: Cambria / Calibri
Dark/light rhythm: slides 1, 4, 8 dark; all others light
Visual motif: vertical accent rail + tinted icon circle
Motif placement: divider card edge, KPI cards, chart insight panel
Card/background treatment: alternate white cards on NEUTRAL and NEUTRAL cards on white
Banned defaults: blue title bars, accent lines under titles, repeated 3-column white cards

SLIDE ROUTING TABLE
1 | cover | title + subtitle + attribution | TYPE 1 | full-bleed | dark | summary bar: no | motif in background texture
2 | agenda | 3 pillars | TYPE 6 | Template D | light | summary bar: yes | motif in top bars
3 | proof | chart + insight | TYPE 11 | chart split | light | summary bar: no | motif in insight rail
4 | section divider | chapter opener | TYPE 2 | divider card | dark | summary bar: no | motif in card edge

VARIETY GATES
Adjacent visual types unique: yes
Column-count run <= 2: yes
Dark rhythm satisfied: yes
Card-heavy slides <= 50% of content slides: yes
At least one non-card-led content slide: yes
Summary bars <= 50% of content slides: yes
```

Rules:

- `SLIDE ROUTING TABLE` must be deck-complete. Do not plan only the first few slides and improvise the rest later.
- The `purpose` field states what the slide is doing in the story, not just what objects it contains.
- `Card-heavy slides` means `TYPE 3`, `TYPE 5`, `TYPE 6`, and `TYPE 8`.
- `Non-card-led content slides` means `TYPE 4`, `TYPE 7`, `TYPE 9`, `TYPE 10`, and `TYPE 11`.
- `Summary bar` means any bottom summary/takeaway strip, including a required strip in `TYPE 8`.
- If a gate does not apply because the deck is too short, mark it `n/a` with a brief reason instead of forcing a fake `yes`.
- If any applicable line in `VARIETY GATES` would be `no`, revise the deck design lock or slide routing table before writing code.


---

### Color Palettes

Choose colors that match your topic. The palette drives the entire deck's feel. Do not default to generic blue.

Palette structure (required):
- `PRIMARY` - dominant color, used for large backgrounds, section slides, strong accents (~60% visual weight)
- `ACCENT` - secondary highlight, used for card top bars, icon backgrounds, stat numbers (~20%)
- `NEUTRAL` - off-white or light tint, used for card backgrounds and body slide backgrounds (~20%)
- `TEXT_DARK` - near-black for body text on light backgrounds
- `TEXT_LIGHT` - white or near-white for text on dark or primary backgrounds

| Theme | PRIMARY | ACCENT | NEUTRAL | TEXT_DARK | TEXT_LIGHT |
|-------|---------|--------|---------|-----------|------------|
| **Teal & Coral** | `028090` | `F96167` | `F0FAFA` | `2D3748` | `FFFFFF` |
| **Midnight Executive** | `1E2761` | `E8A838` | `F5F7FA` | `1A202C` | `FFFFFF` |
| **Forest & Moss** | `2C5F2D` | `97BC62` | `F5F5EE` | `1C2E1C` | `FFFFFF` |
| **Warm Terracotta** | `B85042` | `A7BEAE` | `F9F6F0` | `3D2B1F` | `FFFFFF` |
| **Ocean Depth** | `065A82` | `02C39A` | `EBF8FF` | `1A2F3A` | `FFFFFF` |
| **Charcoal Minimal** | `36454F` | `F4A261` | `F8F8F6` | `2D3436` | `FFFFFF` |
| **Berry & Cream** | `6D2E46` | `E8C39E` | `FDF8F4` | `3D1A2A` | `FFFFFF` |
| **Cherry Bold** | `990011` | `2F3C7E` | `FFF8F8` | `1A0005` | `FFFFFF` |

---

### Slide Visual Type Catalog

Every slide must be assigned one of the following types before layout begins. The type determines the layout template, the elements required, and the coordinate budget to use from `pptx-layout-constraints.md`.

---

#### TYPE 1 - Full-Bleed Cover

Use for: title slide, closing slide

```
+-----------------------------------------+
|  [Full slide background: PRIMARY color  |
|   or gradient image]                    |
|                                         |
|      [Optional: frosted glass card      |
|       centered, white fill, 70% width,  |
|       ~2.5" tall, y-centered ~1.5~4.0"] |
|                                         |
|  MAIN TITLE (white, 44pt bold)          |
|  Subtitle (white/light, 20pt)           |
|  Attribution (small, bottom strip)      |
+-----------------------------------------+
```

Rules:
- Budget reference: full-bleed; content bottom must be <= `5.25"`. Do not use a separate footer zone.
- Background: solid `PRIMARY`, or a tinted image (add a semi-transparent `PRIMARY` overlay rectangle).
- Optional frosted card: `RECTANGLE`, fill white with `transparency: 20`, no border.
- Title centered horizontally. **No accent line under the title.**
- Attribution must be integrated into the design (e.g., a subtle bottom strip) and stay above `y=5.25"`.
- May add large abstract shapes (low-opacity `ACCENT` circles/rectangles) as decorative background texture.

---

#### TYPE 2 - Section Divider

Use for: chapter transition slides (01/02/03, etc.)

```
+----------------------+------------------+
|  [Dark or image bg]  |  White card      |
|                      |  [Section number]|
|  [Illustration or    |  [Section title] |
|   abstract shape]    |  [Tagline]       |
|                      |  [Small icon]    |
+----------------------+------------------+
```

Rules:
- Budget reference: full-bleed; content bottom must be <= `5.25"`. Do not use a separate footer zone.
- Left half: full-height image or abstract decorative elements on dark or muted background.
- Right half: white card (`x:5.00, y:0.60, w:4.50, h:4.40`), shadow, no rounded corners.
- Section number: 72pt, `ACCENT` color, top of card.
- Section title: 28pt bold, `TEXT_DARK`.
- Tagline: 14pt, muted gray.
- Small icon or motif at bottom of card: `w:0.40, h:0.40`.
- Background: `PRIMARY` color or very dark neutral, not white.

---

#### TYPE 3 - Hero KPI

Use for: key metrics or highlights slides (3 KPIs max)

```
+-----------------------------------------+
|  [Title]                                |
|  +--------+  +--------+  +--------+     |
|  |[Icon]  |  |[Icon]  |  |[Icon]  |     |
|  |        |  |        |  |        |     |
|  |  XX    |  |  XX    |  |  XX    |     |
|  |  label |  |  label |  |  label |     |
|  |  body  |  |  body  |  |  body  |     |
|  +--------+  +--------+  +--------+     |
|  [Optional bottom takeaway bar]         |
+-----------------------------------------+
```

Rules:
- Budget reference: Template F in `pptx-layout-constraints.md` Section 3.2 F (use exact coordinates).
- Each KPI card: white background, left accent bar `w:0.07` in alternating `PRIMARY`/`ACCENT` colors.
- Icon: in a tinted circle (`w:0.55, h:0.55`), circle fill = `NEUTRAL` or light `ACCENT` tint.
- KPI number: 36-40pt bold, `ACCENT` or `PRIMARY` color.
- Label: 14pt bold, `TEXT_DARK`.
- Body line: >= 14pt, muted gray, 1 short line.
- Optional bottom summary/takeaway bar: full-width, `NEUTRAL` background, 12pt centered text in `PRIMARY` color. Use it only when the slide genuinely needs a one-line takeaway.

---

#### TYPE 4 - Left-Image / Right-Content

Use for: case study, project detail, narrative slides

```
+------------------+----------------------+
|                  |  [Context box]       |
|  [Image]         |  ------------------- |
|                  |  [Icon] Bold header  |
|  [Caption bar]   |  body text           |
|  in ACCENT bg    |  ------------------- |
|                  |  [Icon] Bold header  |
|                  |  body text           |
|                  |  ------------------- |
|                  |  [Icon] Bold header  |
|                  |  body text           |
+------------------+----------------------+
```

Rules:
- Budget reference: Template G in `pptx-layout-constraints.md` Section 3.2 G (use exact coordinates for image and text areas).
- Image: rounded via `rounding` or a border rectangle overlay for visual frame.
- Caption bar: full-width rectangle at bottom of image (`y: image_bottom - 0.40`, `h:0.40`), `ACCENT` fill, white 11pt centered text, `margin:0`.
- Right side content items: max 3, each with left accent bar + icon in tinted circle + bold header + 1-2 lines body (>= 14pt).
- Left accent bars alternate between `PRIMARY` and `ACCENT` colors across items.
- If there is a summary bar at bottom, reduce image/text height per the summary-bar rules in `pptx-layout-constraints.md`.

---

#### TYPE 5 - 2x2 Card Grid

Use for: 4-item framework, pros/cons, quad analysis

```
+-----------------------------------------+
|  [Title]                                |
|  +-------------+ +-------------+        |
|  |[Top bar]    | |[Top bar]    |        |
|  |[Icon]       | |[Icon]       |        |
|  |Header       | |Header       |        |
|  |body text    | |body text    |        |
|  +-------------+ +-------------+        |
|  +-------------+ +-------------+        |
|  |[Top bar]    | |[Top bar]    |        |
|  |[Icon]       | |[Icon]       |        |
|  |Header       | |Header       |        |
|  |body text    | |body text    |        |
|  +-------------+ +-------------+        |
+-----------------------------------------+
```

Rules:
- Budget reference: Template C in `pptx-layout-constraints.md` Section 3.2 C (use exact coordinates).
- Each card: white `RECTANGLE` background, light shadow (`blur:4, offset:1, opacity:0.10`).
- Top accent bar per card: `h:0.07`, alternating `PRIMARY`/`ACCENT` colors.
- Icon: in tinted circle (`w:0.50, h:0.50`) placed inside card, top-left area.
- Header: 14pt bold; body: >= 14pt, max 2 lines.
- No bottom summary bar on this type - the grid already fills the budget.

---

#### TYPE 6 - 3-Column Cards

Use for: agenda, strategy pillars, 3-step process

```
+-----------------------------------------+
|  [Title]                                |
|  +--------+ +--------+ +--------+       |
|  |[Top]   | |[Top]   | |[Top]   |       |
|  |[Icon]  | |[Icon]  | |[Icon]  |       |
|  |Number  | |Number  | |Number  |       |
|  |Header  | |Header  | |Header  |       |
|  |body    | |body    | |body    |       |
|  +--------+ +--------+ +--------+       |
|  [Optional bottom takeaway bar]         |
+-----------------------------------------+
```

Rules:
- Budget reference: Template D in `pptx-layout-constraints.md` Section 3.2 D (use exact coordinates).
- Each column is a card: white background, shadow.
- Top bar: `h:0.07`, alternating `PRIMARY` on odd columns, `ACCENT` on even columns.
- Large number (if agenda/numbered): 40pt bold, `PRIMARY` color.
- Icon below number: `w:0.45, h:0.45` in tinted circle.
- Header: 14pt bold; body: >= 14pt, max 2 lines.
- Optional bottom summary/takeaway bar with summary text in `PRIMARY` color. Reserve summary-bar space first when you include it.

---

#### TYPE 7 - Left-Text / Right-Image (Mirror of TYPE 4)

Rules:
- Budget reference: Template G in `pptx-layout-constraints.md` Section 3.2 G (mirrored).
- Same rules as TYPE 4, but image on right (`x:5.50`) and content on left (`x:0.50, w:4.50`).
- Use this type to avoid visual monotony when multiple case study slides appear in sequence.

---

#### TYPE 8 - 4-Column Horizontal Strip

Use for: action items, learning points, 4-step process

```
+-----------------------------------------+
|  [Title]                                |
|  +----+ +----+ +----+ +----+            |
|  |top | |top | |top | |top |            |
|  |Icn | |Icn | |Icn | |Icn |            |
|  |Hdr | |Hdr | |Hdr | |Hdr |            |
|  |body| |body| |body| |body|            |
|  +----+ +----+ +----+ +----+            |
|  [Bottom takeaway bar]                 |
+-----------------------------------------+
```

Rules:
- Budget reference: custom 4-column strip within the body area; obey summary-bar limits in `pptx-layout-constraints.md` Section 2.2.
- Maximum 4 columns. If there are 5 items, split across two slides (e.g., TYPE 6 + another slide).
- Layout: `col_w = 1.97"`, gap `0.37"`, `x` starts at `0.50"`.
- Col coordinates: `x = 0.50, 2.84, 5.18, 7.52` (all `w:1.97`).
- Each column card height: `h:2.80`, `y:1.10`.
- Top accent bar per card: `h:0.07`.
- Icon circle: `w:0.40, h:0.40`.
- Header: 14pt bold, max 1 line; body: >= 14pt, max 2 lines.
- Bottom summary/takeaway bar required for this layout: `y:4.15, h:0.40`. Count it as this slide's summary bar in planning and variety gates.
- Content bottom must stay <= `y:3.90"` (card bottom = 1.10 + 2.80 = 3.90).

---

#### TYPE 9 - Split Background (Dark Left / Light Right)

Use for: introductory quotes, challenge vs opportunity framing

```
+----------------------+------------------+
|  [PRIMARY background]| [Light bg]       |
|                      |                  |
|  Large quote or      |  Content items   |
|  section number      |  with icons      |
|  in white            |                  |
+----------------------+------------------+
```

Rules:
- Budget reference: left block full-bleed; right content stays within body area (`x:5.50~9.50`, `y:1.10~4.80`, or <= `4.05"` with summary bar).
- Left half: full-height `RECTANGLE` in `PRIMARY` color (`x:0, y:0, w:5.00, h:5.63`).
- Right half: `NEUTRAL` or white background (slide background).
- Left content: centered vertically, white text only, 1 large element (number, quote, or illustration).
- Right content: 2-4 items, each with tinted-circle icon + bold header + 1 line body (>= 14pt).
- No title bar - the visual split is the structure.

---

#### TYPE 10 - Timeline

Use for: milestones, quarterly events, roadmap

Rules:
- Budget reference: Template E in `pptx-layout-constraints.md` Section 3.2 E (use exact coordinates).
- Maximum 4 nodes (split to a second slide for 5+).
- Timeline axis: `LINE` shape, `y:2.00`, full width, `PRIMARY` color, `width:2pt`.
- Each node: dot circle on axis + card below (or above alternating for visual interest).
- Card: white background, `w:2.03, h:2.00`, shadow.
- Top of card: bold quarter/date label in `ACCENT` color.

---

#### TYPE 11 - Chart + Insight

Use for: data visualization with a short takeaway

```
+-----------------------------------------+
|  [Title]                                |
|  [Chart area ~60-70% width]  [Insight]  |
|  [Chart area]               [Insight]   |
|  [Chart area]               [Insight]   |
|  [Optional source note]                 |
+-----------------------------------------+
```

Rules:
- Budget reference: `pptx-layout-constraints.md` Section 5.4 (chart occupies ~60-70% of body area; chart + text width <= `9.00"`).
- Suggested layout: chart `x:0.50, y:1.10, w:6.00, h:3.40`; insight `x:6.80, y:1.10, w:2.70, h:3.40`.
- Insight area: 1 bold header + up to 2 body lines (>= 14pt).
- If using a summary bar, reduce both areas to keep content bottom <= `4.05"` and place the bar at `y:4.20"`.
- If you need more than 2 insight lines, split the slide.


---

### Failure Fallback Rule (Mandatory)

1. If content does not fit the template, split the slide.
2. Do not reduce font sizes below the minimums.
3. Do not shrink gaps below 0.30" or push content below the allowed bottom.

### Reusable Visual Component Patterns

These are the atomic building blocks. Use them inside any Visual Type above.

#### Component A - Tinted Icon Circle

```javascript
// Circle background
slide.addShape(pres.shapes.OVAL, {
  x: iconX, y: iconY, w: 0.52, h: 0.52,
  fill: { color: NEUTRAL_TINT }  // e.g. light ACCENT at 80% transparency
});
// Icon image centered on circle
slide.addImage({ data: iconBase64, x: iconX+0.06, y: iconY+0.06, w: 0.40, h: 0.40 });
```

Use `NEUTRAL_TINT` = primary color lightened (mix `PRIMARY` with white, ~85% white). Alternatively use `transparency: 80` on `ACCENT` fill.

#### Component B - Card with Left Accent Bar

```javascript
// Card background
slide.addShape(pres.shapes.RECTANGLE, {
  x: cardX, y: cardY, w: cardW, h: cardH,
  fill: { color: "FFFFFF" },
  shadow: makeShadow()
});
// Left accent bar
slide.addShape(pres.shapes.RECTANGLE, {
  x: cardX, y: cardY, w: 0.07, h: cardH,
  fill: { color: ACCENT }  // or PRIMARY, alternate per card
});
```

#### Component C - Card with Top Accent Bar

```javascript
// Card background
slide.addShape(pres.shapes.RECTANGLE, {
  x: cardX, y: cardY, w: cardW, h: cardH,
  fill: { color: "FFFFFF" },
  shadow: makeShadow()
});
// Top accent bar
slide.addShape(pres.shapes.RECTANGLE, {
  x: cardX, y: cardY, w: cardW, h: 0.07,
  fill: { color: i % 2 === 0 ? PRIMARY : ACCENT }
});
```

#### Component D - Bottom Summary / Takeaway Bar

```javascript
// Full-width bar
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: SUMMARY_BAR_Y, w: 10.00, h: 0.42,
  fill: { color: PRIMARY }  // or NEUTRAL for a softer version
});
slide.addText("summary text here", {
  x: 0.50, y: SUMMARY_BAR_Y, w: 9.00, h: 0.42,
  fontSize: 12, color: "FFFFFF", align: "center", valign: "middle", margin: 0, bold: true
});
```

Where `SUMMARY_BAR_Y` follows the summary-bar budget from `pptx-layout-constraints.md`:
- Content zone bottom <= `4.05"` -> summary bar at `y: 4.20"`

#### Component E - Caption Bar on Image

```javascript
// Place at bottom of image area
slide.addShape(pres.shapes.RECTANGLE, {
  x: imageX, y: imageY + imageH - 0.38, w: imageW, h: 0.38,
  fill: { color: ACCENT }
});
slide.addText("Caption text", {
  x: imageX, y: imageY + imageH - 0.38, w: imageW, h: 0.38,
  fontSize: 11, color: "FFFFFF", align: "center", valign: "middle",
  bold: true, margin: 0
});
```

---

### Layout Variety Rules (Mandatory)

These rules are hard requirements, not suggestions:

1. No two adjacent slides may use the same Visual Type. If you plan TYPE 4 for slide 3 and need a similar layout for slide 4, use TYPE 7 (its mirror) instead.
2. Dark/light rhythm: at minimum, every 4th slide must be a dark-background slide (TYPE 1, TYPE 2, or TYPE 9). Section dividers naturally provide this rhythm.
3. Column count variety: a deck must not use the same column count for more than 2 consecutive content slides. After two 2-column slides, switch to 3-column, full-bleed, or left-image layout.
4. For decks with 4 or more content slides, card-heavy slides (`TYPE 3`, `TYPE 5`, `TYPE 6`, `TYPE 8`) must not exceed 50% of content slides, and the deck must include at least one non-card-led content slide (`TYPE 4`, `TYPE 7`, `TYPE 9`, `TYPE 10`, or `TYPE 11`). For shorter decks, avoid an all-card sequence unless the story genuinely fits a single card-led content slide.
5. Every deck needs a TYPE 1 cover and a TYPE 1 closing slide. Use TYPE 2 once per major section when the deck has section breaks; do not force divider slides into a very short deck with no real section change.
6. Background color variety: light content slides should vary their card/background treatment - not every light slide should have white cards on white background. Alternate white cards on `NEUTRAL` background vs `NEUTRAL` cards on white background.
7. Do not let the same motif expression repeat mechanically on every slide. Reuse the motif family, but vary its position, scale, or role so it feels intentional rather than stamped.

---

### Typography

Choose an interesting font pairing. Do not default to Arial unless a brand system demands it.

| Header Font | Body Font |
|-------------|-----------|
| Georgia | Calibri |
| Arial Black | Arial |
| Calibri | Calibri Light |
| Cambria | Calibri |
| Trebuchet MS | Calibri |

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section number (divider) | 64-72pt bold |
| Section header | 20-24pt bold |
| KPI number | 36-40pt bold |
| Body text | >= 14pt |
| Card header | 14pt bold |
| Captions / notes | 10-12pt muted |

---

### Text Length Budget

Use this to estimate wrapping for 14pt Chinese text before layout:

| Text box width | Approx. characters per line (14pt Chinese) |
|---------------|--------------------------------------------|
| 9.00" | ~45 |
| 4.25" | ~21 |
| 2.73" | ~13 |
| 2.03" | ~10 |
| 1.97" | ~9 |

If a line exceeds the estimate, treat it as two lines when computing height.


---

### Spacing

- 0.50" minimum slide margins
- 0.30" minimum gap between any two elements
- Leave breathing room - do not fill every inch

---

### Avoid (Common Mistakes)

- Do not let `pptxgenjs.md` replace the deck design lock or slide routing table. It contains implementation patterns, not permission to skip the `DECK DESIGN LOCK`.
- Do not write a `DECK DESIGN LOCK` full of vague adjectives and then ignore it when laying out slides.
- Never use accent lines under titles - this is a hallmark of AI-generated slides. Use whitespace, background color change, or a small icon instead.
- Do not default to `blue title + white card + 3 equal columns`, even when the source content arrives as three bullets.
- Do not choose a layout because the bullet count happens to fit. Choose the content intent first, then the Visual Type.
- Do not center body text - left-align paragraphs; center only titles and bottom summary/takeaway bars.
- Do not mix spacing randomly - pick 0.30" or 0.50" gaps and use consistently.
- Do not create text-only slides - every slide needs at least one of: icon set, image, chart, or shape composition.
- Do not use decorative shapes that occupy more than 40% of slide area without carrying substantive content. Placeholder circles or abstract fills must contain real data, icons, or stats, not filler text.
- Do not use low-contrast elements - icons and text must have strong contrast against their backgrounds.
- Do not use `ROUNDED_RECTANGLE` with accent overlay bars - use `RECTANGLE` instead (see `pptxgenjs.md` pitfalls).
- Do not reuse option objects - always use a `makeShadow()` factory function.
