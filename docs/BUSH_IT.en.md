# bush-it

[English](BUSH_IT.en.md) · [简体中文](BUSH_IT.md)

[中文](BUSH_IT.en.md) | [Documentation](README.md)

bush-it is a Markdown-centered writing, organization and presentation tool. It opens a blank page: edit a title and body, then insert content or configure collaboration as needed. Documents need no nodes or executable tasks. Ordinary `.md` files can be opened, edited, previewed and saved directly.

Its sidebar provides pages, creation, search and trash, with a return to conversation navigation. The page header keeps the page name and insertion controls. The name menu exposes configuration, Markdown source, graph, Team and file operations. The contents and relation overview are initially collapsed; enabling relations adds a thumbnail at the article's end. The graph is another view of the same document, not a separate execution format.

## Editing and saving

- Edit the title/body in Document view. The top or paragraph `+`, or `/` at a paragraph start, inserts headings, lists, checklists, quotes, code, tables, rules and images. Text selection exposes formatting. Changes synchronize to Markdown with undo and IME composition support.
- Markdown view edits the complete source. Invalid intermediate metadata or configuration changes retain text and cursor; an older graph cannot overwrite current input.
- Referenceable sections add independently linkable content. With Team enabled, Team tasks explicitly participate in execution. Ordinary prose needs no section configuration, and configuration appears only when opened.
- Insertion follows the active body/section title; menus stay near their trigger. Consecutive image insertions preserve content. Outside click/Esc closes menus. In narrow windows the contents opens as an overlay, closing after section selection/body click without shrinking the article column.
- Graphs support drag, zoom, pan, auto arrangement and Alt + arrows. Document references and Team dependencies are distinct: solid arrows mean dependencies, dashed edges mean references.
- Pages autosave locally across navigation/restarts and can be restored from trash. An old single draft becomes the first page. Open/reload creates a new page, preserving current drafts. Cancelled file selection leaves content intact. Saves check file revisions and reject external-change overwrites.
- Images can be linked or uploaded as PNG/JPEG/WebP/GIF up to 700 KB; uploads embed in Markdown. Unsupported raw HTML/reference links remain editable source blocks. Rich-text editing may normalize Markdown whitespace/formatting; source view retains direct editing access.

Limits are 2 × 1024 × 1024 text characters and 128 structured sections. Team executes at most 64 task sections; explanatory sections do not count. Ordinary Markdown headings need not become nodes. On local-storage failure, the UI offers saving `.md`; in-memory edits remain available.

## Content and configuration in one file

Optional YAML front matter holds document properties. Organize the body freely, including rationale; no fixed outline is required. Add an `md-node` block immediately after a level-two heading for independent references, diagrams or Team configuration. `name` is the display label; the heading ID is the stable reference.

````markdown
---
name: Order review
author: Project team
team:
  id: order-review
  description: Verify evidence before delivering a conclusion
  max_parallel: 2
---

# Order review

## Why collaborate

Inventory and order details come from different sources; verify them separately before combining gaps.

## rationale
```md-node
name: Rationale and notes
```

This is ordinary prose, not an executable task. See [[#stock|Inventory check]].

## stock
```md-node
name: Inventory check
agent_id: warehouse
depends_on: []
```

Check inventory from the input; return quantities, sources and missing information.

## report
```md-node
name: Final report
agent_id: reviewer
depends_on: [stock]
```

Use upstream evidence to report the conclusion, evidence and unresolved questions.
````

`[[#sectionID]]` / `[[#sectionID|label]]` are document references, not execution dependencies. Fenced/inline code and escaped references do not create edges. Team executes only sections with `agent_id` and schedules only explicit `depends_on`. Ordinary references may form cycles; execution dependencies must be acyclic.

Unclosed code blocks and `md-node` examples are preserved through multiline `markdown` metadata rather than consuming later sections. Optional `position` affects only graph layout. This feature organizes one `.md` file; it does not scan an external Obsidian vault.

## From document to execution and back

Choose the Team practice action in the name menu to add execution configuration. Select employees, instructions and prerequisites for executable sections; other content stays explanatory. Employee registration continues to manage role instructions, tools, Hooks, guards and memory.

Save `.md` writes a file. Save to Team persists the executable definition through Runtime and the full article in `presentation.markdown`, retaining rationale, headings, notes and additional properties. An execution-only update omitting `presentation` preserves the article. Subsequent display maps current employee/task/dependency definitions back into it.

Practice first saves Team, selects it for the conversation and prepares a message. An Agent with model/permission context executes after the input is confirmed. Opening, reading, editing or expanding graphs does not run tasks.

Team's document tab and chat Inspector reuse the same document view, initially read-only with optional relations. Edit in bush-it brings the document into the writing interface; saving to Team makes it available in both places. Agent-created Teams without articles can generate readable prose from names, descriptions, tasks and dependencies.

Legacy graph-style Team Markdown remains readable; re-export uses separate `team` configuration and explicit dependencies. Saves still validate enabled employees, IDs, instructions, dependencies and revision. Runs freeze their initial definition without a second model loop.

See the [complete collaboration example](examples/team-order-review.en.md).

## Verification

`npm run test:md-presentation` covers document/Team round trips, reference/dependency separation, prose preservation, graphical editing, file conflicts and Chromium document/practice/narrow-window UI. `npm run test:team` covers execution, memory, scheduling, result notifications and persistence boundaries.
