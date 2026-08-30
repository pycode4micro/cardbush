---
name: pptx
description: "Use this skill any time a `.pptx` file, slide deck, or presentation deliverable is involved as input, output, or both. This includes creating presentations, formal slides, pitch decks, investor decks, deck-style deliverables, or slide-based reports; reading or extracting text from `.pptx` files; editing or updating existing presentations; combining or splitting slide files; and working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions `deck`, `slides`, `presentation`, `formal slides`, `deliver a presentation`, or a `.pptx` filename."
description_zh: "只要任务以 `.pptx` 文件、slide deck 或 presentation 交付物为输入、输出或处理中间对象，就使用此 skill。这包括创建演示文稿、正式 slides、PPT、路演 deck、pitch deck、deck 风格交付物或基于幻灯片的报告；读取、解析或抽取 `.pptx` 文件内容；修改已有演示文稿；合并或拆分幻灯片文件；以及处理模板、版式、讲者备注或评论。只要用户提到 PPT、slides、presentation、formal slides、deck、交付一份演示稿，或直接提到 `.pptx` 文件名，就应触发。"
required_reads:
  - pptxgenjs.md
  - references/pptx-layout-constraints.md
conditional_reads:
  - editing.md: Edit existing or template-based decks
  - references/pptx-design-patterns.md: Create from scratch, substantial redesign, pitch deck, strategy deck, investor deck, or any deck where visual quality and slide variety matter
license: Proprietary. LICENSE.txt has complete terms
---

# PPTX Skill

## Hard Implementation Rules

**These rules are mandatory whenever the deliverable includes a new or regenerated PPT deck.**

- **Mandatory**: all PPT generation in this skill must be implemented through **PptxGenJS**.
- **Do not substitute** PptxGenJS with `python-pptx`, `reportlab`, or any other Python presentation/PDF library when the task is to generate or regenerate a `.pptx` deliverable.
- If the environment is missing Node.js, `pptxgenjs`, or other required JavaScript dependencies, install or repair them first. **Do not work around the requirement by switching to Python libraries.**
- In mixed tasks that involve both spreadsheets and presentations, keep the spreadsheet side in its own toolchain, but keep the PPT generation side on **PptxGenJS**.
- The only exception is the existing-template XML editing workflow described in [editing.md](editing.md). That workflow is for editing an existing `.pptx` structure, not for replacing deck generation with Python libraries.
- If the deck is based on researched data, browser results, documents, or prior tool output, write from a fact ledger. Every number, date, source claim, chart value, trend statement, or risk factor used on slides must trace back to a source URL/title/date or a specific tool-result record. If evidence is missing, state the gap. If more evidence is required before a useful deck can be produced, pause and request replan/read-stage recovery instead of trying to browse from the write stage or filling slides with plausible unsupported content.

## Bush Presentation Quality Contract

Use the presentation plugin's taste level as the bar, but keep this skill's Bush implementation path:

- **Implementation stays Bush-native**: PptxGenJS source, local helper scripts, terminal execution, rendered previews, and file-level artifact checks. Do not switch to artifact-tool JSX or another deck engine unless a separate Bush tool explicitly provides that path.
- **North Star**: the deck must pass the contact-sheet test. A reviewer should understand the story, visual system, slide rhythm, and evidence quality from slide thumbnails before opening the file.
- **Slide purpose first**: every slide needs a claim, proof object, and layout role. Filler bullets, generic card grids, and decorative-only shapes are defects.
- **Source story**: for evidence-backed decks, keep the fact ledger active from planning through QA. Slide claims should come from source material, not from later decorative writing.
- **Workspace hygiene**: keep scratch source, renders, PDFs, and extracted assets in a task-specific workspace. Deliver the final `.pptx` and only mention scratch paths when they are useful for debugging.
- **Final answer discipline**: do not declare the deck finished until the generated `.pptx` has been rendered or inspected, content has been extracted, and at least one visual QA pass has been completed.

## Runtime Control Boundary

Runtime control owns permissions, schema visibility, execution truth, progress, and completion. This skill contributes only a presentation workflow: task mode, deck profile, story spine, design lock, slide routing table, source ledger, and QA checklist. It does not grant capabilities, choose provider transport, or decide completion. When evidence changes the goal or scope, update the working approach directly and continue from the smallest grounded next action.

## Deck Reflection Loop

Use this loop for create-from-scratch, substantial redesign, pitch, strategy,
investor, product, and report decks. Keep it concise. The goal is to prevent a
technically valid but generic deck, not to add ceremony.

### Before Building

Answer these before the `DECK DESIGN LOCK` and use the answers to shape it:

1. **Audience pressure**: what decision, belief, or action should the audience
   leave with?
2. **Story spine**: what is the one-sentence thesis, and what proof objects
   make it credible?
3. **Thumbnail read**: at contact-sheet size, what rhythm should be visible:
   chapter breaks, data beats, image-led moments, diagrams, or comparison
   frames?
4. **Design restraint**: which visual move will repeat, and which common deck
   trope is banned for this topic?
5. **Evidence posture**: is this a sourced analytical deck, a concept/story
   deck, or a template-following edit? Do not mix those modes accidentally.

If these answers are vague, tighten the story before choosing slide coordinates.
If a template or brand deck exists, reflection should explain how to preserve
and sharpen that system, not replace it.

### After Rendering

After thumbnails or slide images exist, run one self-review pass before final
delivery:

- Does the contact sheet tell a coherent story without opening individual
  slides?
- Does each slide have one claim and one proof object, rather than a pile of
  related bullets?
- Are adjacent slides rhythmically distinct without feeling like unrelated
  templates?
- Is the design system visible through typography, palette, spacing, motif, and
  data/asset treatment?
- Which slide is weakest at thumbnail size, and was it improved or explicitly
  marked as pending?

Use this reflection to repair the deck. Do not add decoration that weakens
readability or evidence quality just to look more designed.

## Task Mode and Deck Profile Router

Before writing deck code, classify the work in two lightweight dimensions. This is a deck-design aid, not a reason to delay execution or replace the current route.

### Task Mode

| Mode | Use When | Extra Requirement |
|------|----------|-------------------|
| `template_following` | The user provides an existing deck, brand template, or strong reference | Preserve the template's visual contract before applying this skill's design ideas |
| `create_from_scratch` | The user asks for a new deck and no template dominates | Use the full `DECK DESIGN LOCK`, routing table, and visual type catalog |
| `targeted_edit` | The task updates, fixes, combines, extracts, or localizes slides | Minimize layout churn; verify edited slides and any affected neighbors |

### Deck Profile

Choose the closest profile and let it influence layout density, proof objects, and tone:

| Profile | Best For | Design Bias |
|---------|----------|-------------|
| `finance_ir` | investor, board, market, KPI, forecast, valuation | charts, source notes, sober contrast, appendix-ready evidence |
| `product_platform` | product strategy, roadmap, architecture, platform pitch | system diagrams, flows, capability maps, before/after states |
| `gtm_growth` | sales, marketing, launch, funnel, customer proof | segmentation, funnel visuals, case evidence, strong narrative beats |
| `engineering_platform` | technical leadership, reliability, infra, migration | architecture maps, risk tables, timelines, incident-proof framing |
| `strategy_leadership` | exec narrative, operating model, decision memo | crisp claims, few but strong proof objects, clear recommendations |
| `consumer_retail` | brand, product, venue, audience-facing story | authentic imagery, tactile palette, fewer abstract diagrams |
| `appendix_heavy` | evidence pack, research packet, due diligence | navigation, compact tables, explicit sources, lower visual flourish |

If the deck crosses profiles, pick one primary profile and one secondary influence. Do not blend styles randomly slide by slide.

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | `python -m markitdown presentation.pptx` |
| Edit or create from template | Read [editing.md](editing.md) |
| Create from scratch | Read [pptxgenjs.md](pptxgenjs.md), [references/pptx-layout-constraints.md](references/pptx-layout-constraints.md), and for polished visual work [references/pptx-design-patterns.md](references/pptx-design-patterns.md); then lock deck design, assign slide routing, and follow the required source and layout rules below |

---

## Reading Content

```bash
# Text extraction
python -m markitdown presentation.pptx

# Visual overview
python scripts/thumbnail.py presentation.pptx

# Raw XML
python scripts/office/unpack.py presentation.pptx unpacked/
```

---

## Editing Workflow

**Read [editing.md](editing.md) for full details.**

1. Analyze template with `thumbnail.py`
2. Unpack → manipulate slides → edit content → clean → pack

---

## Creating from Scratch

**Read [pptxgenjs.md](pptxgenjs.md) and [references/pptx-layout-constraints.md](references/pptx-layout-constraints.md) for full details.**

Use when no template or reference presentation is available.

Treat `pptxgenjs.md` as an API-first implementation guide. It includes code patterns and some visual execution helpers, but it does not replace the deck design lock and slide routing in this skill. Lock the deck direction here before you touch coordinates.

**Implementation lock**: when creating a deck from scratch, the source of truth must be JavaScript built on **PptxGenJS**. Do not fall back to Python because it feels faster or more familiar.

## Mandatory Bush PPTX Workflow

For non-trivial create or regenerate tasks, follow this sequence:

1. Confirm `Task Mode` and `Deck Profile`.
2. Read the required implementation/layout references for the selected mode.
3. Build or recover the fact ledger when the deck depends on external sources, tool outputs, documents, or user-provided data.
4. Draft the story spine: cover promise, section beats, slide claims, proof objects, and closing action.
5. Produce the `DECK DESIGN LOCK` and complete `SLIDE ROUTING TABLE`.
6. Generate the deck from a single PptxGenJS `index.js` unless the user explicitly asks for a different source layout.
7. Extract text with `markitdown` and render thumbnails or slide images.
8. Run lock compliance, content QA, and visual QA; repair defects and re-render affected slides.
9. Deliver the final `.pptx` only after verification evidence exists.

## Layout Constraint Resource

**Required when laying out slides from scratch or when editing slide geometry manually.**

- Treat [references/pptx-layout-constraints.md](references/pptx-layout-constraints.md) as the authoritative layout safety spec for page budgets, safe regions, content density, and split-slide decisions.
- If the planned content violates the card count, timeline node count, text density, or body-area limits in that file, split the content into additional slides instead of shrinking fonts or compressing spacing.
- When `pptxgenjs.md` gives API-level guidance and `references/pptx-layout-constraints.md` gives layout-budget guidance, follow both. The layout-constraint file is the source of truth for slide fit and overflow prevention.

## Source Layout Requirements

**Required when the output includes source code that generates or edits a presentation.**

- Land generated PPTX source in a single `index.js` by default, even for multi-slide decks.
- Do not create per-slide source files such as `slides/slide-01-cover.js`, and do not split the deck by slide count.
- Keep shared constants, theme values, helper functions, and slide-building logic in the same `index.js` unless the user explicitly asks for a refactored multi-file source layout.
- Organize the single file with clear sections and small local helpers near the top when needed, but keep one file as the source of truth for deck generation.
- The entry file should both define the deck and write the final `.pptx`; avoid a thin bootstrap file plus a tree of slide modules.
- Do not call `write_file` on the same path more than once in a turn. If a generated source file needs corrections after the initial write, use `edit_file` instead of rewriting the whole file.

---

## Design Pattern Reference

For create-from-scratch or substantial redesign work, read
[references/pptx-design-patterns.md](references/pptx-design-patterns.md) after the
`DECK DESIGN LOCK` and before writing PptxGenJS coordinates. That file contains
the visual type catalog, palette options, component patterns, typography budgets,
and variety gates. Keep this main skill focused on task mode, story, evidence,
implementation path, and QA.

## QA (Required)

**Assume there are problems. Your job is to find them.**

Your first render is almost never correct. Approach QA as a bug hunt, not a confirmation step. If you found zero issues on first inspection, you weren't looking hard enough.

### Content QA

```bash
python -m markitdown output.pptx
```

Check for missing content, typos, wrong order.

**When using templates, check for leftover placeholder text:**

```bash
python -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|this.*(page|slide).*layout"
```

If grep returns results, fix them before declaring success.

### Lock Compliance QA

Do not assume the `DECK DESIGN LOCK` was followed just because it was written once. Treat lock drift as a real bug.

Before visual inspection, compare each generated slide against both:

- the `DECK DESIGN LOCK`
- the `SLIDE ROUTING TABLE`

Run this per-slide checkpoint after code generation and before final sign-off:

```text
Slide N - Lock Compliance Check
□ Background role matches plan (`PRIMARY` / `NEUTRAL` / dark / light)
□ Dark/light rhythm matches the planned slide role
□ Typography matches the locked display/body font pairing
□ Visual Type matches the planned type in the routing table
□ Layout/template matches the intended slide structure, not a fallback generic card layout
□ Summary bar usage matches the plan
□ Visual motif appears in the planned place or role
□ Banned defaults are absent
```

Minimum interpretation:

- If a slide was planned as dark, it must not quietly become a light slide because the code drifted.
- If a slide was planned as `TYPE 11`, it must not turn into a generic three-card summary slide just because the content was easy to fit.
- If the lock banned `blue title + white card + 3 equal columns`, finding that pattern is a failure even if the slide is technically readable.

Any mismatch between the generated slide and the lock or slide routing table must be fixed before declaring the deck complete.

### Visual QA

Use an independent visual pass whenever possible. A subagent is useful when
available because fresh eyes catch layout defects the builder misses. If
subagents are unavailable or the runtime route does not support them, run the
same checklist yourself against the rendered slide images and state that the
visual pass was self-review rather than independent review.

Convert slides to images (see [Converting to Images](#converting-to-images)),
list the actual generated image paths with a one-line expectation for each
slide, then use this prompt for the independent or self-review pass:

```
Visually inspect these slides. Assume there are issues — find them.

Look for:
- Overlapping elements (text through shapes, lines through words, stacked elements)
- Text overflow or cut off at edges/box boundaries
- Decorative lines positioned for single-line text but title wrapped to two lines
- Source citations or footers colliding with content above
- Elements too close (< 0.3" gaps) or cards/sections nearly touching
- Uneven gaps (large empty area in one place, cramped in another)
- Insufficient margin from slide edges (< 0.5")
- Columns or similar elements not aligned consistently
- Low-contrast text (e.g., light gray text on cream-colored background)
- Low-contrast icons (e.g., dark icons on dark backgrounds without a contrasting circle)
- Text boxes too narrow causing excessive wrapping
- Leftover placeholder content

For each slide, list issues or areas of concern, even if minor.

Read and analyze the actual converted slide images from the previous step.
The caller will provide one line per image with the real file path and a brief description of what the slide should contain.

Report ALL issues found, including minor ones.
```

### Verification Loop

1. Generate slides
2. Run `Lock Compliance QA` against the `DECK DESIGN LOCK` and `SLIDE ROUTING TABLE`
3. Convert to images → Inspect
4. **List issues found** (include both visual defects and lock/routing violations; if none found, look again more critically)
5. Fix issues
6. **Re-verify affected slides** — one fix often creates another problem
7. Repeat until a full pass reveals no new issues

**Do not declare success until you've completed at least one lock-compliance pass and one fix-and-verify cycle.**

---

## Converting to Images

Convert presentations to individual slide images for visual inspection:

```bash
python scripts/office/soffice.py --headless --convert-to pdf output.pptx
rm -f slide-*.jpg
pdftoppm -jpeg -r 150 output.pdf slide
ls -1 "$PWD"/slide-*.jpg
```

This creates `slide-01.jpg`, `slide-02.jpg`, etc.

To re-render specific slides after fixes:

```bash
pdftoppm -jpeg -r 150 -f N -l N output.pdf slide-fixed
```

---

## Dependencies

- `pip install "markitdown[pptx]"` - text extraction
- `pip install Pillow` - thumbnail grids
- `npm install -g pptxgenjs` - creating from scratch
- LibreOffice (`soffice`) - PDF conversion (auto-configured for sandboxed environments via `scripts/office/soffice.py`)
- Poppler (`pdftoppm`) - PDF to images
