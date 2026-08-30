# PptxGenJS Tutorial

## Quick Reference

| Field | Value |
|---|---|
| Label | Create PPT decks from scratch |
| Use when | There is no existing deck or template to reuse and you need to generate slides programmatically |
| Gives you | PptxGenJS API patterns, single-file deck structure, visual-style helpers, and generation rules for new presentations |
| Not for | Template-based edits to an existing presentation |
| Pair with | [references/pptx-layout-constraints.md](references/pptx-layout-constraints.md) |

For any deck that requires non-trivial positioning, slide budgeting, or split-slide decisions, pair this guide with [references/pptx-layout-constraints.md](references/pptx-layout-constraints.md). This file explains how to use the API; the layout-constraints file defines what is allowed to fit on a slide.

Use `SKILL.md` to decide the deck's direction, slide routing, and variety rules first. Use this file to implement that deck lock and routing cleanly in code.

## Required Project Structure

For generated PPTX code, keep the whole deck in a single source file by default. Do not split code into one file per slide.

Recommended structure:

```text
deck/
└── index.js                  # Full deck definition: metadata, theme, helpers, slides, writeFile
```

Rules:

- Keep deck generation in one `index.js`, regardless of slide count.
- Do not create `slides/`, `slide-01.js`, `constants.js`, or section assembly files unless the user explicitly asks for a multi-file code layout.
- Put shared constants, theme tokens, reusable coordinates, and tiny helper functions near the top of the same file.
- Keep the file readable with named helpers and comment sections, but treat `index.js` as the single source of truth for the full deck.
- The same file should create the presentation, define slides in order, and write the output file.

## Setup & Basic Structure

```javascript
const pptxgen = require("pptxgenjs");

let pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';  // or 'LAYOUT_16x10', 'LAYOUT_4x3', 'LAYOUT_WIDE'
pres.author = 'Your Name';
pres.title = 'Presentation Title';

let slide = pres.addSlide();
slide.addText("Hello World!", { x: 0.5, y: 0.5, fontSize: 36, color: "363636" });

pres.writeFile({ fileName: "Presentation.pptx" });
```

## Layout Dimensions

Slide dimensions (coordinates in inches):
- `LAYOUT_16x9`: 10" × 5.625" (default)
- `LAYOUT_16x10`: 10" × 6.25"
- `LAYOUT_4x3`: 10" × 7.5"
- `LAYOUT_WIDE`: 13.3" × 7.5"

When working in `LAYOUT_16x9`, use [references/pptx-layout-constraints.md](references/pptx-layout-constraints.md) as the authoritative source for:

- title/body/footer safe regions
- maximum cards, bullets, comparison columns, and timeline nodes
- content-density limits
- split-slide decisions when one slide would otherwise overflow

---

## Visual Bias Correction

This guide explains the API and gives implementation-side visual helpers, but it does not replace the deck design lock or slide routing table.

If the brief calls for a deck that feels energetic, contemporary, approachable, optimistic, or personal, do **not** default to dark navy + gold + white cards everywhere. That combination often reads older, more formal, and more corporate than the intended tone.

Prefer these biases unless the brief or brand says otherwise:

- Use brighter palette families such as `Teal & Coral` or `Warm Terracotta` when the deck should feel lively, warm, or contemporary rather than formal and institutional.
- Use at least one gradient or split-background slide in any non-trivial deck.
- Use decorative geometry as atmosphere: low-opacity circles, rotated bands, cropped color blocks, or split panels.
- Let at least one slide be image-led and at least one slide be chart-led instead of making every slide a card grid.
- Treat cards as one layout tool, not the default answer for every content type.

### Theme Tokens to Declare Near the Top of `index.js`

```javascript
const THEMES = {
  tealCoral: {
    PRIMARY: "028090",
    ACCENT: "F96167",
    NEUTRAL: "F0FAFA",
    TEXT_DARK: "2D3748",
    TEXT_LIGHT: "FFFFFF",
  },
  warmTerracotta: {
    PRIMARY: "B85042",
    ACCENT: "A7BEAE",
    NEUTRAL: "F9F6F0",
    TEXT_DARK: "3D2B1F",
    TEXT_LIGHT: "FFFFFF",
  },
};

const TOKENS = THEMES.tealCoral;

const makeShadow = () => ({
  type: "outer",
  color: "000000",
  blur: 6,
  offset: 2,
  angle: 135,
  opacity: 0.15,
});
```

If the deck is meant to feel energetic, warm, or contemporary, start from one of these instead of inventing a safe business palette on the fly.

### Gradient Background Helper

PptxGenJS does not support true gradient fills for shapes. For deck backgrounds, generate a gradient image once and reuse it.

```javascript
const sharp = require("sharp");

async function makeGradientPngData(colorA, colorB, width = 1600, height = 900) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#${colorA}" />
          <stop offset="100%" stop-color="#${colorB}" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)" />
    </svg>`;

  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + pngBuffer.toString("base64");
}

const heroGradient = await makeGradientPngData(TOKENS.PRIMARY, TOKENS.ACCENT);
slide.background = { data: heroGradient };
```

Use this for cover slides, divider slides, and quote slides when a flat fill feels too static.

---

## Text & Formatting

```javascript
// Basic text
slide.addText("Simple Text", {
  x: 1, y: 1, w: 8, h: 2, fontSize: 24, fontFace: "Arial",
  color: "363636", bold: true, align: "center", valign: "middle"
});

// Character spacing (use charSpacing, not letterSpacing which is silently ignored)
slide.addText("SPACED TEXT", { x: 1, y: 1, w: 8, h: 1, charSpacing: 6 });

// Rich text arrays
slide.addText([
  { text: "Bold ", options: { bold: true } },
  { text: "Italic ", options: { italic: true } }
], { x: 1, y: 3, w: 8, h: 1 });

// Multi-line text (requires breakLine: true)
slide.addText([
  { text: "Line 1", options: { breakLine: true } },
  { text: "Line 2", options: { breakLine: true } },
  { text: "Line 3" }  // Last item doesn't need breakLine
], { x: 0.5, y: 0.5, w: 8, h: 2 });

// Text box margin (internal padding)
slide.addText("Title", {
  x: 0.5, y: 0.3, w: 9, h: 0.6,
  margin: 0  // Use 0 when aligning text with other elements like shapes or icons
});
```

**Tip:** Text boxes have internal margin by default. Set `margin: 0` when you need text to align precisely with shapes, lines, or icons at the same x-position.

---

## Lists & Bullets

```javascript
// ✅ CORRECT: Multiple bullets
slide.addText([
  { text: "First item", options: { bullet: true, breakLine: true } },
  { text: "Second item", options: { bullet: true, breakLine: true } },
  { text: "Third item", options: { bullet: true } }
], { x: 0.5, y: 0.5, w: 8, h: 3 });

// ❌ WRONG: Never use unicode bullets
slide.addText("• First item", { ... });  // Creates double bullets

// Sub-items and numbered lists
{ text: "Sub-item", options: { bullet: true, indentLevel: 1 } }
{ text: "First", options: { bullet: { type: "number" }, breakLine: true } }
```

---

## Shapes

```javascript
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 0.8, w: 1.5, h: 3.0,
  fill: { color: "FF0000" }, line: { color: "000000", width: 2 }
});

slide.addShape(pres.shapes.OVAL, { x: 4, y: 1, w: 2, h: 2, fill: { color: "0000FF" } });

slide.addShape(pres.shapes.LINE, {
  x: 1, y: 3, w: 5, h: 0, line: { color: "FF0000", width: 3, dashType: "dash" }
});

// With transparency
slide.addShape(pres.shapes.RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: "0088CC", transparency: 50 }
});

// Rounded rectangle (rectRadius only works with ROUNDED_RECTANGLE, not RECTANGLE)
// ⚠️ Don't pair with rectangular accent overlays — they won't cover rounded corners. Use RECTANGLE instead.
slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: "FFFFFF" }, rectRadius: 0.1
});

// With shadow
slide.addShape(pres.shapes.RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: "FFFFFF" },
  shadow: { type: "outer", color: "000000", blur: 6, offset: 2, angle: 135, opacity: 0.15 }
});
```

Shadow options:

| Property | Type | Range | Notes |
|----------|------|-------|-------|
| `type` | string | `"outer"`, `"inner"` | |
| `color` | string | 6-char hex (e.g. `"000000"`) | No `#` prefix, no 8-char hex — see Common Pitfalls |
| `blur` | number | 0-100 pt | |
| `offset` | number | 0-200 pt | **Must be non-negative** — negative values corrupt the file |
| `angle` | number | 0-359 degrees | Direction the shadow falls (135 = bottom-right, 270 = upward) |
| `opacity` | number | 0.0-1.0 | Use this for transparency, never encode in color string |

To cast a shadow upward (e.g. on a footer bar), use `angle: 270` with a positive offset — do **not** use a negative offset.

**Note**: Gradient fills are not natively supported. Use a gradient image as a background instead.

### Decorative Geometry That Adds Energy

Do not use shapes only as boxes behind text. Shapes are also your atmosphere layer.

```javascript
// Large off-canvas circle for background energy
slide.addShape(pres.shapes.OVAL, {
  x: -0.6, y: -0.8, w: 2.8, h: 2.8,
  fill: { color: TOKENS.ACCENT, transparency: 82 },
  line: { color: TOKENS.ACCENT, transparency: 100 },
});

// Rotated band for motion
slide.addShape(pres.shapes.RECTANGLE, {
  x: 7.8, y: -0.2, w: 2.4, h: 6.2,
  rotate: 18,
  fill: { color: TOKENS.PRIMARY, transparency: 88 },
  line: { color: TOKENS.PRIMARY, transparency: 100 },
});

// Thin accent rail
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0.45, y: 1.1, w: 0.08, h: 3.2,
  fill: { color: TOKENS.ACCENT },
  line: { color: TOKENS.ACCENT, transparency: 100 },
});
```

Use 2-4 decorative shapes on a slide, not 12. They should create direction, layering, or framing without competing with the content.

### Split-Background Pattern

A split background is an easy way to avoid all-slides-look-like-cards syndrome.

```javascript
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 0, w: 4.9, h: 5.625,
  fill: { color: TOKENS.PRIMARY },
  line: { color: TOKENS.PRIMARY, transparency: 100 },
});

slide.addShape(pres.shapes.RECTANGLE, {
  x: 4.9, y: 0, w: 5.1, h: 5.625,
  fill: { color: TOKENS.NEUTRAL },
  line: { color: TOKENS.NEUTRAL, transparency: 100 },
});
```

Use this for quote slides, challenge-vs-opportunity slides, and section transitions where you want stronger visual tension than a white slide can provide.

---

## Images

### Image Sources

```javascript
// From file path
slide.addImage({ path: "images/chart.png", x: 1, y: 1, w: 5, h: 3 });

// From URL
slide.addImage({ path: "https://example.com/image.jpg", x: 1, y: 1, w: 5, h: 3 });

// From base64 (faster, no file I/O)
slide.addImage({ data: "image/png;base64,iVBORw0KGgo...", x: 1, y: 1, w: 5, h: 3 });
```

### Image Options

```javascript
slide.addImage({
  path: "image.png",
  x: 1, y: 1, w: 5, h: 3,
  rotate: 45,              // 0-359 degrees
  rounding: true,          // Circular crop
  transparency: 50,        // 0-100
  flipH: true,             // Horizontal flip
  flipV: false,            // Vertical flip
  altText: "Description",  // Accessibility
  hyperlink: { url: "https://example.com" }
});
```

### Image Sizing Modes

```javascript
// Contain - fit inside, preserve ratio
{ sizing: { type: 'contain', w: 4, h: 3 } }

// Cover - fill area, preserve ratio (may crop)
{ sizing: { type: 'cover', w: 4, h: 3 } }

// Crop - cut specific portion
{ sizing: { type: 'crop', x: 0.5, y: 0.5, w: 2, h: 2 } }
```

### Calculate Dimensions (preserve aspect ratio)

```javascript
const origWidth = 1978, origHeight = 923, maxHeight = 3.0;
const calcWidth = maxHeight * (origWidth / origHeight);
const centerX = (10 - calcWidth) / 2;

slide.addImage({ path: "image.png", x: centerX, y: 1.2, w: calcWidth, h: maxHeight });
```

### Supported Formats

- **Standard**: PNG, JPG, GIF (animated GIFs work in Microsoft 365)
- **SVG**: Works in modern PowerPoint/Microsoft 365

### Let Images Carry Structure, Not Just Decoration

If every slide reduces visuals to tiny icons above text cards, the deck will feel flat even when the code is correct.

Use at least one slide where the image is a primary layout block:

```javascript
slide.addImage({
  path: "images/founder-photo.jpg",
  x: 0.5, y: 1.1, w: 4.5, h: 3.5,
  sizing: { type: "cover", w: 4.5, h: 3.5 },
});

slide.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 4.22, w: 4.5, h: 0.38,
  fill: { color: TOKENS.ACCENT },
  line: { color: TOKENS.ACCENT, transparency: 100 },
});

slide.addText("Caption or proof point", {
  x: 0.5, y: 4.22, w: 4.5, h: 0.38,
  fontSize: 11,
  color: TOKENS.TEXT_LIGHT,
  align: "center",
  valign: "middle",
  margin: 0,
  bold: true,
});
```

Use image-led layouts for founder stories, project snapshots, campus scenes, event recaps, or any slide where credibility improves when the audience can see something real.

---

## Icons

Use react-icons to generate SVG icons, then rasterize to PNG for universal compatibility.

### Setup

```javascript
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const { FaCheckCircle, FaChartLine } = require("react-icons/fa");

function renderIconSvg(IconComponent, color = "#000000", size = 256) {
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(IconComponent, { color, size: String(size) })
  );
}

async function iconToBase64Png(IconComponent, color, size = 256) {
  const svg = renderIconSvg(IconComponent, color, size);
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + pngBuffer.toString("base64");
}
```

### Add Icon to Slide

```javascript
const iconData = await iconToBase64Png(FaCheckCircle, "#4472C4", 256);

slide.addImage({
  data: iconData,
  x: 1, y: 1, w: 0.5, h: 0.5  // Size in inches
});
```

**Note**: Use size 256 or higher for crisp icons. The size parameter controls the rasterization resolution, not the display size on the slide (which is set by `w` and `h` in inches).

### Icon Libraries

Install: `npm install -g react-icons react react-dom sharp`

Popular icon sets in react-icons:
- `react-icons/fa` - Font Awesome
- `react-icons/md` - Material Design
- `react-icons/hi` - Heroicons
- `react-icons/bi` - Bootstrap Icons

---

## Slide Backgrounds

```javascript
// Solid color
slide.background = { color: "F1F1F1" };

// Color with transparency
slide.background = { color: "FF3399", transparency: 50 };

// Image from URL
slide.background = { path: "https://example.com/bg.jpg" };

// Image from base64
slide.background = { data: "image/png;base64,iVBORw0KGgo..." };
```

### Background Rhythm Suggestions

- Cover and section-divider slides should usually use either a gradient background, a tinted image background, or a split background.
- Content slides do **not** all need white backgrounds. Alternate among white, `NEUTRAL`, and image-tinted backgrounds.
- If three light slides appear in a row, vary the treatment: for example `NEUTRAL` background -> white background with geometric texture -> split background.
- A deck feels more alive when background treatment changes by slide purpose, not randomly.

---

## Tables

```javascript
slide.addTable([
  ["Header 1", "Header 2"],
  ["Cell 1", "Cell 2"]
], {
  x: 1, y: 1, w: 8, h: 2,
  border: { pt: 1, color: "999999" }, fill: { color: "F1F1F1" }
});

// Advanced with merged cells
let tableData = [
  [{ text: "Header", options: { fill: { color: "6699CC" }, color: "FFFFFF", bold: true } }, "Cell"],
  [{ text: "Merged", options: { colspan: 2 } }]
];
slide.addTable(tableData, { x: 1, y: 3.5, w: 8, colW: [4, 4] });
```

---

## Charts

```javascript
// Bar chart
slide.addChart(pres.charts.BAR, [{
  name: "Sales", labels: ["Q1", "Q2", "Q3", "Q4"], values: [4500, 5500, 6200, 7100]
}], {
  x: 0.5, y: 0.6, w: 6, h: 3, barDir: 'col',
  showTitle: true, title: 'Quarterly Sales'
});

// Line chart
slide.addChart(pres.charts.LINE, [{
  name: "Temp", labels: ["Jan", "Feb", "Mar"], values: [32, 35, 42]
}], { x: 0.5, y: 4, w: 6, h: 3, lineSize: 3, lineSmooth: true });

// Pie chart
slide.addChart(pres.charts.PIE, [{
  name: "Share", labels: ["A", "B", "Other"], values: [35, 45, 20]
}], { x: 7, y: 1, w: 5, h: 4, showPercent: true });
```

### Better-Looking Charts

Default charts look dated. Apply these options for a modern, clean appearance:

```javascript
slide.addChart(pres.charts.BAR, chartData, {
  x: 0.5, y: 1, w: 9, h: 4, barDir: "col",

  // Custom colors (match your presentation palette)
  chartColors: ["0D9488", "14B8A6", "5EEAD4"],

  // Clean background
  chartArea: { fill: { color: "FFFFFF" }, roundedCorners: true },

  // Muted axis labels
  catAxisLabelColor: "64748B",
  valAxisLabelColor: "64748B",

  // Subtle grid (value axis only)
  valGridLine: { color: "E2E8F0", size: 0.5 },
  catGridLine: { style: "none" },

  // Data labels on bars
  showValue: true,
  dataLabelPosition: "outEnd",
  dataLabelColor: "1E293B",

  // Hide legend for single series
  showLegend: false,
});
```

**Key styling options:**
- `chartColors: [...]` - hex colors for series/segments
- `chartArea: { fill, border, roundedCorners }` - chart background
- `catGridLine/valGridLine: { color, style, size }` - grid lines (`style: "none"` to hide)
- `lineSmooth: true` - curved lines (line charts)
- `legendPos: "r"` - legend position: "b", "t", "l", "r", "tr"

### Chart + Insight Pattern

When a slide contains real data, let the chart do the heavy lifting and keep the explanation short.

```javascript
slide.addChart(pres.charts.BAR, chartData, {
  x: 0.5, y: 1.1, w: 6.0, h: 3.4, barDir: "col",
  chartColors: [TOKENS.PRIMARY, TOKENS.ACCENT, "F4B860"],
  showLegend: false,
  showValue: true,
  dataLabelPosition: "outEnd",
  dataLabelColor: TOKENS.TEXT_DARK,
  catAxisLabelColor: "64748B",
  valAxisLabelColor: "64748B",
  valGridLine: { color: "E2E8F0", size: 0.5 },
  catGridLine: { style: "none" },
  chartArea: { fill: { color: "FFFFFF" } },
});

slide.addShape(pres.shapes.RECTANGLE, {
  x: 6.85, y: 1.1, w: 0.08, h: 3.4,
  fill: { color: TOKENS.ACCENT },
  line: { color: TOKENS.ACCENT, transparency: 100 },
});

slide.addText("Why this matters", {
  x: 7.05, y: 1.15, w: 2.25, h: 0.4,
  fontSize: 16, bold: true, color: TOKENS.TEXT_DARK, margin: 0,
});

slide.addText([
  { text: "Momentum is strongest in the newest segment.", options: { breakLine: true } },
  { text: "Keep insight text to 1-2 lines, not a paragraph." },
], {
  x: 7.05, y: 1.65, w: 2.25, h: 1.2,
  fontSize: 14, color: TOKENS.TEXT_DARK, margin: 0,
});
```

This is almost always stronger than showing three KPI cards and then restating the same numbers in words.

### When to Use a Chart Instead of Cards

- Timeline or sequential stages: use a shape-based timeline (`LINE` + `OVAL` + cards below), not plain text cards in columns.
- Comparative numbers: use a `BAR` chart, not stat callout cards.
- Progress or completion rate: use a `DOUGHNUT` chart, not text percentages alone.
- Survey results or segment mix: use `BAR`, `PIE`, or `DOUGHNUT`, not repeated mini-cards with percentages.
- Trend over time: use a `LINE` chart with one short takeaway, not bullet points describing movement.

---

## Slide Masters

```javascript
pres.defineSlideMaster({
  title: 'TITLE_SLIDE', background: { color: '283A5E' },
  objects: [{
    placeholder: { options: { name: 'title', type: 'title', x: 1, y: 2, w: 8, h: 2 } }
  }]
});

let titleSlide = pres.addSlide({ masterName: "TITLE_SLIDE" });
titleSlide.addText("My Title", { placeholder: "title" });
```

---

## Common Pitfalls

⚠️ These issues cause file corruption, visual bugs, or broken output. Avoid them.

1. **NEVER use "#" with hex colors** - causes file corruption
   ```javascript
   color: "FF0000"      // ✅ CORRECT
   color: "#FF0000"     // ❌ WRONG
   ```

2. **NEVER encode opacity in hex color strings** - 8-char colors (e.g., `"00000020"`) corrupt the file. Use the `opacity` property instead.
   ```javascript
   shadow: { type: "outer", blur: 6, offset: 2, color: "00000020" }          // ❌ CORRUPTS FILE
   shadow: { type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.12 }  // ✅ CORRECT
   ```

3. **Use `bullet: true`** - NEVER unicode symbols like "•" (creates double bullets)

4. **Use `breakLine: true`** between array items or text runs together

5. **Avoid `lineSpacing` with bullets** - causes excessive gaps; use `paraSpaceAfter` instead

6. **Each presentation needs fresh instance** - don't reuse `pptxgen()` objects

7. **NEVER reuse option objects across calls** - PptxGenJS mutates options objects in-place. Always use a factory function.
   ```javascript
   const shadow = { type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.15 };
   slide.addShape(pres.shapes.RECTANGLE, { shadow, ... });  // ❌ reused object may already be mutated
   slide.addShape(pres.shapes.RECTANGLE, { shadow, ... });

   const makeShadow = () => ({ type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.15 });
   slide.addShape(pres.shapes.RECTANGLE, { shadow: makeShadow(), ... });  // ✅ fresh object each time
   slide.addShape(pres.shapes.RECTANGLE, { shadow: makeShadow(), ... });
   ```

8. **Don't use `ROUNDED_RECTANGLE` with accent borders** - rectangular overlay bars won't cover rounded corners. Use `RECTANGLE` instead.
   ```javascript
   // ❌ WRONG: Accent bar doesn't cover rounded corners
   slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 1, y: 1, w: 3, h: 1.5, fill: { color: "FFFFFF" } });
   slide.addShape(pres.shapes.RECTANGLE, { x: 1, y: 1, w: 0.08, h: 1.5, fill: { color: "0891B2" } });

   // ✅ CORRECT: Use RECTANGLE for clean alignment
   slide.addShape(pres.shapes.RECTANGLE, { x: 1, y: 1, w: 3, h: 1.5, fill: { color: "FFFFFF" } });
   slide.addShape(pres.shapes.RECTANGLE, { x: 1, y: 1, w: 0.08, h: 1.5, fill: { color: "0891B2" } });
   ```

9. **Don't let every slide become white cards on a flat light background** - this is the fastest route to deck sameness. Use gradients, split backgrounds, image-led slides, and chart-led slides to create rhythm.

10. **Don't shrink every visual into a tiny supporting asset** - if an image, chart, or icon matters, let it occupy real area on the slide instead of floating above text like clip art.

11. **Don't use decorative shapes as filler** - if you add circles, bands, or blocks, they should reinforce direction, framing, or the deck's motif rather than merely occupying empty space.

---

## API Cheat Sheet

- **Shapes**: RECTANGLE, OVAL, LINE, ROUNDED_RECTANGLE
- **Charts**: BAR, LINE, PIE, DOUGHNUT, SCATTER, BUBBLE, RADAR
- **Layouts**: LAYOUT_16x9 (10"×5.625"), LAYOUT_16x10, LAYOUT_4x3, LAYOUT_WIDE
- **Alignment**: "left", "center", "right"
- **Chart data labels**: "outEnd", "inEnd", "center"
