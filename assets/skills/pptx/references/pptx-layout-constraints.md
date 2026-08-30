# PPT Layout Constraint Specification

## Quick Reference

| Field | Value |
|---|---|
| Label | Slide fit and density limits |
| Use when | You need to decide whether slide content still fits on one slide or must be split |
| Gives you | Safe regions, content budgets, and hard layout constraints for PPT slide geometry |
| Not for | API usage details for generating slides |

> This file defines the layout safety rules for PPT generation.  
> Every slide must strictly follow the constraints below.  
> Any slide that violates a hard rule should fail visual QA.

---

## 1. Physical Slide Parameters

### 1.1 Slide Size (16:9 Standard, `LAYOUT_16x9`)

| Parameter | Value |
|------|-----|
| Total width | 10.00" |
| Total height | 5.63" |
| Safe margin | 0.50" on all sides |

### 1.2 Safe Region Definition

```text
┌──────────────────────────────────────┐ 0.00"
│  ┌─────────────────────────────────┐ │ 0.50"
│  │         Title Area             │ │
│  │      y: 0.25~1.05"             │ │ 1.05"
│  ├─────────────────────────────────┤ │
│  │                                 │ │
│  │          Body Area              │ │
│  │      y: 1.10~4.80"             │ │
│  │      usable height: 3.70"       │ │
│  │      usable width: 9.00"        │ │
│  │                                 │ │
│  ├─────────────────────────────────┤ │ 4.80"
│  │          Footer Area            │ │
│  │      y: 4.85~5.25"             │ │ 5.25"
│  └─────────────────────────────────┘ │ 5.63"
└──────────────────────────────────────┘
```

**Hard rules:**

- Every element must satisfy `left >= 0` and `top >= 0`
- Every element must satisfy `left + width <= 10.00"`
- Every element must satisfy `top + height <= 5.63"`
- Body area horizontal bounds: `x: 0.50" ~ 9.50"`
- Body area hard bottom limit: every content element must stay above `5.25"`
- The footer area is for a single line of small text only, such as source, page number, or date, with height no greater than `0.35"`

---

## 2. Content Density Constraints

### 2.1 Maximum Content Blocks Per Slide

This is the most important rule.  
The root cause of overflow is usually not bad coordinates. It is putting too much content on one slide.

| Slide type | Maximum content blocks | Maximum bullet rows per block |
|----------|------------|--------------|
| Title slide | 3 (title + subtitle + attribution) | — |
| Agenda slide | 5 agenda items | 1 title line + 1 description line per item |
| Content slide, single-column | 4 content blocks | 3 text rows per block |
| Content slide, two-column | 3 blocks per column (6 total) | 2 text rows per block |
| Card grid slide | 2×2 = 4 cards | title + 2 rows per card |
| Timeline slide | 4 time nodes | year + title + 1 description row per node |
| Comparison slide | 2 to 3 columns | 4 text rows per column |
| KPI slide | 3 large KPI blocks | number + 1 label row each |
| Closing slide | 3 (summary + contact + CTA) | — |

### 2.2 Footer/Summary Bar Reservation

Many slides end with a full-width summary sentence or takeaway bar at the bottom. This bar competes for the same vertical space as the last row of content — and is the #1 cause of overlapping elements.

**Hard rule: If a slide has a bottom summary bar, the content zone shrinks.**

| Page structure | Content zone bottom limit | Summary bar zone |
|----------------|--------------------------|------------------|
| No summary bar | y ≤ 4.80" | — |
| With summary bar (1 line) | y ≤ 4.05" | y: 4.15" ~ 4.55" |
| With summary bar + footer | y ≤ 3.85" | summary: 4.00" ~ 4.40", footer: 4.50" ~ 4.80" |

The summary bar is NOT free space — it must be budgeted BEFORE laying out content blocks. When planning a slide:

1. Decide first: does this slide have a summary bar? If yes, reserve 0.50" at the bottom.
2. Calculate the available content height: 3.70" (full) → 2.95" (with summary bar).
3. Fit content blocks into the reduced height. If they don't fit, split the page.

**Never place content below y=4.05" on a slide that also has a summary bar.**

**Hard rule: if content exceeds these limits, split it into multiple slides. Never shrink font size or collapse spacing just to force everything onto one slide.**

### 2.3 Slide-Splitting Rules

If a slide would require:

- more than 4 content blocks in a single-column layout, or more than 6 in a two-column layout
- a list longer than 4 items
- a grid larger than `2×2 = 4` cells

**Split the slide immediately.**

Recommended split patterns:

| Original intent | Recommended split |
|---------|------|
| 5 technical domains | Slide 1 shows 2, slide 2 shows 3; or slide 1 is an overview and later slides expand 2 at a time |
| 6 ethical challenges | 3 on the first slide, 3 on the second |
| 5 time nodes | first 3 on one slide, remaining 2 on another |
| 4 policies + 3-year action plan | one slide for policies, one slide for the action plan |
| 5 points on both left and right | first 3 per side on one slide, remaining items on another |

---

## 3. Layout Templates and Coordinate Budgets

### 3.1 Title Area (Shared Across All Slides)

```javascript
// Slide title (required)
{ x: 0.50, y: 0.25, w: 9.00, h: 0.60, fontSize: 36 }

// Subtitle / description (optional)
{ x: 0.50, y: 0.90, w: 9.00, h: 0.40, fontSize: 16 }
```

The title area occupies `y = 0.25` to `1.05`, for a total of `0.80"`.  
The body area begins at `y = 1.10`.

### 3.2 Body Area Layout Templates

**Usable space: `9.00" × 3.70"` (`x: 0.50~9.50`, `y: 1.10~4.80`)**

The coordinate templates below solve geometry only. They define a safe spatial skeleton, not a complete visual design.  
For every slide that uses a template from A-G, choose both:

1. a coordinate template
2. a visual variant listed under that template

This keeps coordinates reusable while preventing repeated "white background + black text" layouts across a deck.

#### A. Single-Column List (Maximum 4 Blocks)

```text
Body height 3.70" ÷ 4 blocks = 0.85" per block including gap
Block height: 0.70", block gap: 0.15"
```

```javascript
const blocks = [
  { x: 0.50, y: 1.10, w: 9.00, h: 0.70 },
  { x: 0.50, y: 1.95, w: 9.00, h: 0.70 },
  { x: 0.50, y: 2.80, w: 9.00, h: 0.70 },
  { x: 0.50, y: 3.65, w: 9.00, h: 0.70 },
];
// Bottom edge of last block: 3.65 + 0.70 = 4.35" ✅ < 4.80"
```

> **With summary bar variant:** Subtract 0.75" from the last block's available y-space.
> Example: use three blocks ending at `y=3.35"` with `h=0.70`, or reduce the fourth block set so the lowest content bottom stays at or above `4.05"`.
> Summary bar: `y=4.20`, `h=0.40`.

**Visual variants**

| Variant ID | Visual treatment | Best for |
|---|---|---|
| `A1 Editorial bands` | Full-width tinted bands or soft containers behind each row, with concise bold titles | Executive summary, key findings, policy headlines |
| `A2 Step sequence` | Large row numbers or progress markers with connector cues across rows | Process, method, roadmap, workflow |
| `A3 Accent rail` | Thin vertical accent bar or icon chip per row, with light background and strong section labels | Principles, capabilities, structured lists |
| `A4 Evidence strip` | Each row pairs a short claim with a right-aligned stat, tag, or source chip | Research synthesis, proof points, audit-style slides |

#### B. Two-Column Layout (Maximum 3 Blocks Per Column, 6 Total)

```text
Left column:  x=0.50, w=4.25
Right column: x=5.25, w=4.25
Column gap: 0.50"

3 blocks per column: 3.70" ÷ 3 = 1.10" per block including gap
Block height: 0.95", gap: 0.15"
```

```javascript
// Left column
const left = [
  { x: 0.50, y: 1.10, w: 4.25, h: 0.95 },
  { x: 0.50, y: 2.20, w: 4.25, h: 0.95 },
  { x: 0.50, y: 3.30, w: 4.25, h: 0.95 },
];
// Right column
const right = [
  { x: 5.25, y: 1.10, w: 4.25, h: 0.95 },
  { x: 5.25, y: 2.20, w: 4.25, h: 0.95 },
  { x: 5.25, y: 3.30, w: 4.25, h: 0.95 },
];
// Bottom edge of last block: 3.30 + 0.95 = 4.25" ✅ < 4.80"
```

> **With summary bar variant:** Subtract 0.75" from the last row's available y-space.
> Example: keep only two full rows, or reduce the third row so the lowest content bottom stays at or above `4.05"`.
> Summary bar: `y=4.20`, `h=0.40`.

**Visual variants**

| Variant ID | Left column treatment | Right column treatment | Best for |
|---|---|---|---|
| `B1 Contrast` | Dark background with white text | Light cards with dark text | Challenge vs solution, before vs after |
| `B2 Media-led` | Image, chart, or diagram with crop/bleed | Explanation, annotation, or takeaway text | Data storytelling, product walkthrough |
| `B3 Metric-led` | Oversized KPI, number, or short headline figure | Trend, implication, or supporting explanation | Results, impact, business review |
| `B4 List-to-detail` | Icon + short-title list | Matching detailed explanation blocks | Capability, feature, service explanation |

#### C. 2×2 Card Grid (Maximum 4 Cards)

```text
Card width:  (9.00 - 0.50) / 2 = 4.25"
Card height: (3.70 - 0.30) / 2 = 1.70"
Gap: 0.50" horizontally, 0.30" vertically
```

```javascript
const cards = [
  { x: 0.50, y: 1.10, w: 4.25, h: 1.70 },  // top-left
  { x: 5.25, y: 1.10, w: 4.25, h: 1.70 },  // top-right
  { x: 0.50, y: 3.10, w: 4.25, h: 1.70 },  // bottom-left
  { x: 5.25, y: 3.10, w: 4.25, h: 1.70 },  // bottom-right
];
// Bottom edge of last card: 3.10 + 1.70 = 4.80" ✅ exactly 4.80"
```

> **With summary bar variant:** Subtract 0.75" from the last block's available y-space.
> For example, a 2×2 card grid with summary bar:
> - Cards: `y=1.10 (h=1.40)`, `y=2.65 (h=1.40)` → bottom at `4.05"` ✅
> - Summary bar: `y=4.20`, `h=0.40`
> - Cards shrink from `h=1.70` to `h=1.40` to make room.

**Visual variants**

| Variant ID | Visual treatment | Best for |
|---|---|---|
| `C1 Equal cards` | Four consistent cards with icon, title, and short body | Taxonomy, four-part framework, category overview |
| `C2 Highlight one` | One dominant accent card and three quieter support cards | Prioritization, hero concept plus supporting themes |
| `C3 Alternating contrast` | Checkerboard light/dark or warm/cool card treatments | Balanced comparisons, trade-offs, option sets |
| `C4 Mini-dashboard` | Stat-first cards with badges, tiny charts, or status indicators | KPI quartets, scorecards, portfolio snapshots |

#### D. 3-Column Layout (Maximum 3 Columns)

```text
Column width: (9.00 - 0.40×2) / 3 = 2.73"
Column gap: 0.40"
```

```javascript
const cols = [
  { x: 0.50, y: 1.10, w: 2.73, h: 3.70 },
  { x: 3.63, y: 1.10, w: 2.73, h: 3.70 },
  { x: 6.76, y: 1.10, w: 2.73, h: 3.70 },
];
// Right edge: 6.76 + 2.73 = 9.49" ✅ < 9.50"
```

> **With summary bar variant:** Subtract 0.75" from the columns' available height.
> Example: `h=2.95` instead of `3.70`, keeping each column bottom at `4.05"` or above.
> Summary bar: `y=4.20`, `h=0.40`.

**Visual variants**

| Variant ID | Column treatment | Best for |
|---|---|---|
| `D1 Pillars` | Three equal columns with strong headers and subtle separators | Strategic pillars, framework breakdown, operating model |
| `D2 Sequence` | Numbered columns with arrows or continuation cues left to right | Three-step process, phased delivery, journey explanation |
| `D3 Benchmark` | One neutral baseline column and two highlighted comparison columns | Option comparison, competitor scan, scenario planning |
| `D4 Icon columns` | Large icon or symbol at top, short label, compact supporting text | Functional overview, service areas, team roles |

#### E. Timeline (Maximum 4 Nodes, Horizontal)

```text
Node width: (9.00 - 0.30×3) / 4 = 2.03"
Node gap: 0.30"
Timeline axis y: 2.00"
Node content area: y=2.30~4.50"
```

```javascript
const nodes = [
  { x: 0.50, y: 2.30, w: 2.03, h: 2.20 },
  { x: 2.83, y: 2.30, w: 2.03, h: 2.20 },
  { x: 5.16, y: 2.30, w: 2.03, h: 2.20 },
  { x: 7.47, y: 2.30, w: 2.03, h: 2.20 },
];
// Right edge: 7.47 + 2.03 = 9.50" ✅, bottom remains 4.50" ✅
```

> **With summary bar variant:** Subtract 0.75" from the node content zone.
> Example: keep the axis at `y=2.00`, but shorten each node content block to end at `4.05"` or above.
> Summary bar: `y=4.20`, `h=0.40`.

**Visual variants**

| Variant ID | Visual treatment | Best for |
|---|---|---|
| `E1 Milestone cards` | Each node appears as a discrete card beneath a shared axis | Project plans, historical overviews, release timelines |
| `E2 Journey emphasis` | One node is visually dominant, others are secondary | Transformation stories, key turning points, narrative arcs |
| `E3 Maturity ramp` | Color intensity, size, or emphasis increases from left to right | Growth stages, maturity models, capability evolution |
| `E4 Evidence timeline` | Dates paired with mini charts, icons, or numeric deltas | Performance history, adoption curves, product launches |

#### F. Large KPI Layout (Maximum 3 KPIs)

```text
KPI block width: (9.00 - 0.50×2) / 3 = 2.67"
Gap: 0.50"
```

```javascript
const kpis = [
  { x: 0.50, y: 1.50, w: 2.67, h: 2.50 },
  { x: 3.67, y: 1.50, w: 2.67, h: 2.50 },
  { x: 6.84, y: 1.50, w: 2.67, h: 2.50 },
];
// Bottom edge: 1.50 + 2.50 = 4.00" ✅
```

> **With summary bar variant:** This layout already fits comfortably if KPI blocks stop at `4.00"`.
> Keep the KPI bottom at or above `4.00"`, then place the summary bar at `y=4.20`, `h=0.40`.

**Visual variants**

| Variant ID | Visual treatment | Best for |
|---|---|---|
| `F1 Dashboard` | Bold number, compact label, and a subtle trend cue under each KPI | Monthly review, status snapshot, management reporting |
| `F2 Benchmark` | Each KPI includes target vs actual or a status badge | Goal tracking, OKRs, performance monitoring |
| `F3 Story-first` | One hero KPI uses a strong accent, two supporting KPIs are quieter | Keynote impact slide, investor summary, standout result |
| `F4 Proof-backed` | KPI plus delta, source chip, or comparison note inside each block | Research-backed claims, audit, compliance, due diligence |

#### G. Left Image / Right Text or Left Text / Right Image

```text
Image area: width 4.50", height 3.50"
Text area:  width 4.00", height 3.50"
Gap: 0.50"
```

```javascript
// Image left, text right
const imageArea = { x: 0.50, y: 1.10, w: 4.50, h: 3.50 };
const textArea  = { x: 5.50, y: 1.10, w: 4.00, h: 3.50 };
// Bottom edge: 1.10 + 3.50 = 4.60" ✅
```

> **With summary bar variant:** Reduce both the image and text areas by `0.55"~0.75"` so their bottom edge stays at or above `4.05"`.
> Example: use `h=2.95` for both areas, then place the summary bar at `y=4.20`, `h=0.40`.

**Visual variants**

| Variant ID | Media/text treatment | Best for |
|---|---|---|
| `G1 Full-bleed media` | One side is a cropped image or illustration, the other is concise narrative text | Case study, product showcase, scene-setting slide |
| `G2 Diagram explain` | One side holds a chart, diagram, or architecture visual, the other holds annotations | Technical explanation, workflow, system overview |
| `G3 Quote/profile` | Portrait or contextual image on one side, quote or insight block on the other | Customer story, leadership message, testimonial |
| `G4 Stat + narrative` | Large number, symbol, or compact visual on one side, implication text on the other | Outcome storytelling, synthesis, impact summary |

### 3.3 Visual Variant Selection and Deck Diversity Rules

The same coordinate template can support many different slide designs.  
To prevent visual homogenization, geometry reuse must be paired with visual variation.

**Hard rules:**

- A slide is not fully specified until it has both a coordinate template and a visual variant.
- Reusing a coordinate template across a deck is allowed.
- Reusing the same template + visual variant pair in the same deck is not allowed.
- **Do not use the same visual variant of the same template more than once in a single deck.**

If a template must be reused later in the deck, change at least two of the following:

- background contrast treatment
- dominant media type (`text`, `icon`, `number`, `image`, or `chart`)
- hierarchy driver (headline-led, metric-led, image-led, or list-led)
- container style (plain, carded, banded, or full-bleed)

Recommended planning rule for LLMs:

- Track template usage with short codes such as `A2`, `B3`, `E1`.
- Before rendering a slide, check whether that exact code has already appeared in the same deck.
- If yes, switch to another variant or another template before generating shapes.

---

## 4. Text Capacity Constraints

### 4.1 Text Line Height and Capacity

| Font size (pt) | Line height (") | Typical use |
|-----------|---------|------|
| 36-44 | 0.55-0.65 | Slide title |
| 20-24 | 0.38-0.42 | Section title |
| 14-16 | 0.28-0.32 | Body text / bullets |
| 10-12 | 0.22-0.25 | Footer / note |

### 4.2 Maximum Text Rows Per Block

```text
Block height 0.70" → fits: 1 title row (20pt) + 1 body row (14pt)
Block height 0.95" → fits: 1 title row (20pt) + 2 body rows (14pt)
Block height 1.70" → fits: 1 title row (24pt) + 3 body rows (14pt) + 1 note row (10pt)
```

**Hard rule: body text must never go below 14pt, and footer text must never go below 10pt. Do not shrink font size to fit more content.**

### 4.3 Chinese Text Width Estimate

For Chinese text at roughly 14pt, assume each character is about `0.20"` wide.  
A `9.00"` text box can fit about 45 Chinese characters including punctuation.  
A `4.25"` text box can fit about 21 Chinese characters.

If a line exceeds the text box capacity, it will wrap automatically and consume extra height.  
**When planning, always account for wrapping. If the content exceeds one-line capacity, calculate height using the real wrapped line count.**

---

## 5. Constraints for Special Slide Types

### 5.1 Title Slide

```text
Title: 1 row, 36~44pt, slightly above vertical center
Subtitle: 1 row, 16~20pt
Attribution + date: lower quarter of the slide
Decorative elements: must never cover text
```

### 5.2 Agenda Slide

```text
Maximum 5 agenda items
Each item: number + title (1 row) + optional note (1 row)
Height budget: 0.60~0.75" per item
5 items total: 3.00~3.75" ✅ around the body budget

If more than 5 items: split into 2 slides, or merge closely related topics
```

### 5.3 Comparison Slide

```text
2-column comparison: each column width 4.25"
3-column comparison: each column width 2.73"
Inside each column: title + up to 4 bullets
4 or more comparison columns are not allowed
```

### 5.4 Data / Chart Slide

```text
Chart should occupy 60~70% of the body area: width 5.50~6.50", height 3.00~3.50"
Chart-side explanation area: width 2.50~3.00"
Charts must not overlap text
Chart + explanation combined width must not exceed 9.00"
```

---

## 6. Boundary Check Checklist

Run this checklist for every slide:

```text
□ 1. Count content blocks — does the slide exceed the chosen template limit? If yes, split it.
□ 2. Count text rows per block — does any block exceed 3 body rows? If yes, trim or split it.
□ 3. Is the bottom-most element's (top + height) < 5.25"?
□ 3a. If this slide has a summary/takeaway bar at the bottom:
      Is the lowest CONTENT element's bottom ≤ 4.05"?
      Is there ≥ 0.10" gap between the last content element and the summary bar?
□ 4. Is the right-most element's (left + width) < 9.50"?
□ 5. Does any element have left < 0 or top < 0?
□ 6. Is body text >= 14pt and footer text >= 10pt?
□ 7. In columns or grids, is the spacing between neighboring elements >= 0.30"?
□ 8. For timelines or horizontal series, is node count <= 4?
□ 9. For card grids, is the grid <= 2×2?
□ 10. Is the total number of shapes on the slide < 30? If not, simplify it.
□ 11. If this template is reused elsewhere in the same deck, is it using a different visual variant code?
```

---

## 7. Common Overflow Cases and Fix Templates

### Case A: 5+ Technical Domains or Categories

❌ Wrong: 5 cards in a 2×3 grid, causing the third row to overflow  
✅ Correct:

- Option 1: slide 1 shows an overview list, later slides expand 2 items at a time
- Option 2: slide 1 uses a 2×2 = 4-card grid, slide 2 shows the 5th card plus summary

### Case B: 5 Items on Both Left and Right

❌ Wrong: 5 blocks per side in a two-column slide, pushing content below the safe body area  
✅ Correct:

- Split into 2 slides: first slide has 3 items per side, second slide has the remaining 2
- Or use the first slide for the top 3 comparisons and the second for the rest plus conclusion

### Case C: 5+ Timeline Nodes

❌ Wrong: 5 or 6 nodes laid out horizontally, overflowing the right edge  
✅ Correct:

- Maximum 4 nodes per slide
- 5 nodes → split 3 + 2
- 6 nodes → split 3 + 3

### Case D: Large Text Block + Chart + Supporting Notes

❌ Wrong: chart + large paragraph below + footer note, creating vertical overflow  
✅ Correct:

- A chart slide should include the chart plus only 1 to 2 lines of key takeaway text
- Move detailed explanation to the next slide

### Case E: Complex Policy / Framework + Action Plan

❌ Wrong: 4 policy cards plus a 3-column action plan on the same slide, which is effectively two slides worth of content  
✅ Correct:

- Slide 1: policy framework in a 2×2 card grid
- Slide 2: action plan in a 3-column layout

### Scenario F: Content blocks collide with bottom summary bar

❌ Wrong: 4 content rows ending at `y=4.45"` + summary bar starting at `y=4.35"`  
✅ Fix options:

- Option 1: Reduce content to 3 rows (fit within `y ≤ 4.05"`), keep summary bar at `y=4.20"`
- Option 2: Remove the summary bar — the last content row IS the takeaway
- Option 3: Move summary text into the last content block as its final line, eliminate the separate bar
- Option 4: Split into two slides — content on first, summary + elaboration on second

The root cause is always the same: the summary bar was added AFTER content layout
instead of being reserved BEFORE. Budget it first, then fill remaining space with content.

---

## 8. Execution Summary for LLMs

**Before generating any slide, answer these five questions first:**

1. **How many content blocks does this slide need?** If it is more than 4 for single-column or more than 6 for two-column, split the slide before writing code.
2. **Which coordinate template fits this slide?** Choose one from Section 3.2, templates A through G, and use the precomputed coordinates directly.
3. **Which visual variant fits this slide, and has that exact template + variant already appeared in this deck?** Pick a variant code such as `B2` or `F1`; if that code was already used earlier in the deck, choose another one.
4. **What is the bottom edge of the last element?** Mentally compute `y + h` for the final block. It must stay below `4.80"`.
5. **Does this slide have a bottom summary bar?** If yes, content must stop at `y=4.05"`. Budget the summary bar FIRST, then fit content into the remaining space — not the other way around.

**Never do the following:**

- Shrink font size just to fit more content
- Place any body content below `y > 4.80"`
- Put more than 4 cards on one slide
- Lay out more than 4 equal-width horizontal elements
- Reuse the exact same template + visual variant pair across multiple slides in the same deck
- Default repeated templates to the same plain visual treatment without making a deliberate variant choice
- Assume PowerPoint will auto-paginate for you — it will not, and overflow content will simply disappear

**Always do the following:**

- Split slides when content grows; one more slide is better than overflow
- Count content blocks first, pick a template second, pick a visual variant third, place coordinates last
- Track template/variant codes across the deck to avoid repeated visual treatments
- Reuse budgeted coordinate templates instead of inventing ad hoc positions
