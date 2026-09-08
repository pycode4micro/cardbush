# PPTX Design Patterns

## Quick Reference

| Field | Value |
|---|---|
| Label | Deck visual pattern catalog |
| Use when | Creating or substantially redesigning a deck from scratch after the story spine and deck profile are known |
| Gives you | Planning aids, slide patterns, palettes, typography, and reusable components |
| Not for | Reading/editing an existing deck, route control, or source/data validation |
| Pair with | `pptxgenjs.md` and `references/pptx-layout-constraints.md` |

Use this file only after the main skill has selected create-from-scratch or substantial redesign. It is a visual pattern catalog, not an execution route.


> Scope: Optional design patterns for new decks and substantial redesigns. User requirements and existing templates take precedence. Coordinates below target a 10 × 5.625 inch slide; recalculate them for other sizes. Geometry budgets apply to the selected example, not every possible slide.

Prioritize an understandable argument and readable evidence. A text-only slide can be appropriate; visual variety should serve comprehension.

---

### Plan only what helps the deck

Choose the main argument, intended audience, and the role of each slide before
placing elements. Preserve a supplied template or brand system. For a small
deck, a short outline plus palette and typography is enough; for a complex
deck, a routing table can keep claims, proof objects, and layouts coherent.

A useful working note might contain:

```text
Audience and intended decision:
Main argument and supporting sources:
Palette and typography:
Slide | purpose/claim | evidence or proof object | layout
```

Keep these notes with the working source; there is no required user-facing
design-lock block. Update them when evidence or rendering suggests a better
choice. Do not add dark slides, charts, photographs, motifs, or extra pages just
to meet a visual quota.

### Content-to-layout options

| Content intent | Useful patterns |
|---|---|
| Cover, closing, single idea | TYPE 1, or a concise text composition |
| Section transition | TYPE 2 when a real section break is useful |
| KPI or metric highlights | TYPE 3 |
| Case study, image-supported explanation | TYPE 4 or TYPE 7 |
| Four-part framework or quadrant | TYPE 5 |
| Three pillars or steps | TYPE 6 |
| Four-step sequence | TYPE 8 |
| Quote, tension, before/after | TYPE 9 |
| Timeline or roadmap | TYPE 10 |
| Chart and interpretation | TYPE 11 |

These are options, not an exhaustive classifier. Use a different layout when it
represents the content better. Budget any title, source note, and summary bar
before filling the body.

---

### Color Palettes

Choose colors that fit the topic, audience, and brand. The palettes below are examples; blue and single-background decks are valid when appropriate.

A useful palette structure:
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

Consult the patterns relevant to your content. Each includes a suggested composition and budget from `pptx-layout-constraints.md`; adapt it to the actual slide size and brief.

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
- This example budgets 4 columns. For more items, use a different composition or split when the brief allows it.
- Layout: `col_w = 1.97"`, gap `0.37"`, `x` starts at `0.50"`.
- Col coordinates: `x = 0.50, 2.84, 5.18, 7.52` (all `w:1.97`).
- Each column card height: `h:2.80`, `y:1.10`.
- Top accent bar per card: `h:0.07`.
- Icon circle: `w:0.40, h:0.40`.
- Header: 14pt bold, max 1 line; body: >= 14pt, max 2 lines.
- This example includes a bottom summary/takeaway bar at `y:4.15, h:0.40`; reserve its space if you keep it.
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
- This example budgets 4 nodes. For more, adapt the geometry or split when the requested page count permits.
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
- If the insight needs more text, reconsider the chart/text balance or split when the brief allows it.


---

### When content does not fit

1. Edit redundant text or choose a better composition; preserve required evidence.
2. Split a slide when the requested page count allows it. Otherwise prioritize the requested content, use notes/appendices if appropriate, and disclose a real constraint when needed.
3. Verify actual legibility, spacing, and clipping after rendering. Do not squeeze text into unreadability.

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

### Visual rhythm

Review the contact sheet for coherence and unnecessary repetition. Different
slide roles can benefit from different emphasis, backgrounds, or media. Repeated
layouts also help readers compare similar evidence, so do not mirror columns,
switch backgrounds, or add divider slides simply to force variety.

Use images and charts when the evidence calls for them. Keep repeated typography,
spacing, and visual semantics stable. There are no fixed quotas for dark slides,
column counts, cards, or summary bars.

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

- Keep the argument and evidence visible through the design; API examples alone do not decide the story.
- Use decorative rules, icons, and accents only when they clarify hierarchy.
- Do not turn every input list into equal cards by habit; choose a composition that explains the content.
- Do not choose a layout because the bullet count happens to fit. Choose the content intent first, then the Visual Type.
- Do not center body text - left-align paragraphs; center only titles and bottom summary/takeaway bars.
- Do not mix spacing randomly - pick 0.30" or 0.50" gaps and use consistently.
- Do not add an icon, image, chart, or shape solely to avoid a text-only slide.
- Avoid decorative filler that crowds out evidence or weakens the hierarchy.
- Do not use low-contrast elements - icons and text must have strong contrast against their backgrounds.
- Do not use `ROUNDED_RECTANGLE` with accent overlay bars - use `RECTANGLE` instead (see `pptxgenjs.md` pitfalls).
- Do not reuse option objects - always use a `makeShadow()` factory function.
