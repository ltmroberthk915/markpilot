# MarkPilot — AI-native Markdown editor for Windows, VS Code & Trae

**A free Typora alternative with inline AI completion, live math editing, and print-quality typography.**

[![version](https://img.shields.io/badge/version-2.0.18-blue)](https://github.com/ltmroberthk915/markpilot/releases/latest)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20VS%20Code%20%7C%20Trae-green)](https://github.com/ltmroberthk915/markpilot/releases/latest)
[![price](https://img.shields.io/badge/price-free-brightgreen)](https://github.com/ltmroberthk915/markpilot/releases/latest)
[![license](https://img.shields.io/badge/license-app%20free%20%7C%20source%20licensed-orange)](#license)

*[中文说明 / Chinese README →](README.md)*

MarkPilot is a Markdown editor built for people who write in Markdown every day: while you type one sentence, it is already drafting the next one, and underneath the text sits a real Chinese/Japanese/Korean typography engine. One editing core, two shapes — a native Windows desktop app, or an extension inside VS Code and Trae.

If you are looking for **a Typora alternative that is free**, keeps working offline, and can be extended into your AI IDE, this is the one to try.

## Why people switch from Typora

|  | MarkPilot | Typora |
| --- | --- | --- |
| Inline AI completion (cloud + local engine) | ✅ | ❌ |
| Click any symbol in a rendered formula to edit its source (works inside tables and nested blocks) | ✅ | partial |
| Print-quality CJK typography (CJK/Latin spacing, serif themes, Knuth–Plass line breaking on export) | ✅ | partial |
| Large-file performance (chunked rendering + source cache) | ✅ | ❌ |
| Runs inside VS Code / Trae as an extension | ✅ | ❌ desktop only |
| Price | **Free** | $14.99 |

## Five things you will not get from Typora

### ✦ Inline AI completion, the way you actually write

It knows which section you are in, what came before, and whether you are inside a formula — then shows a grey ghost suggestion right after the caret; press `Tab` to accept. Two engines: a cloud model (**DeepSeek / GLM by Zhipu**, plug in your own key) plus a local rule engine (formulas, templates, paths) that keeps working offline or without a key. Your API key is stored in local encrypted storage — never uploaded, never bundled into the installer.

### ✦ Formulas you can actually edit

Rendered math, Typora-style: you see the formula, and when the caret comes near, the relevant source appears for editing with instant preview. MarkPilot goes further and maps the rendered output back to the source — **click any symbol in a formula and the caret lands exactly on the source that produced it**; change one character in the source and the element updates immediately. This mapping survives formulas inside table cells and nested structures, with precise undo/redo. Formulas stop being "pictures you can't touch" and become live, editable content.

### ✦ The editor moves into your AI IDE

The whole editing core ships as a standard extension: install the VSIX in VS Code or Trae and a Markdown workbench appears in the activity bar — full editor, outline tree, AI completion, all running natively inside the IDE. Write documentation in your AI IDE without switching windows.

### ✦ Large files that stay smooth

Chunked background rendering with source-cache reuse: open a big document, keep typing, undo, jump through the outline — it stays responsive even with thousands of formulas. In our internal benchmarks, CPU cost per edit dropped by 57–87%.

### ✦ Print-quality typography

The part of the 2.0 series we polished hardest:

- **Automatic CJK/Latin spacing** — breathing room between Chinese, Latin and digits, without disturbing pixel layout inside formulas and code;
- **Serif dual themes** (Song/Ming styles, light and dark) — Chinese serif body text paired with Georgia for Latin, hairline-stroke outlines, dark-mode tables that don't collapse into black stripes, Chinese italics rendered in Kai style;
- **1280 px reading measure** — no more reading a wide screen line-by-line to the edge;
- **Knuth–Plass optimal line breaking on export**, the same family of algorithm TeX has used for forty years of mathematical typesetting.

## Everything else

- Three modes — live preview / WYSIWYG / source — switch any time
- Outline tree in the sidebar, click a heading to jump
- Smart table editing, including formulas inside cells
- Mermaid diagrams, hundreds of code-highlight themes, paste-and-archive images
- Floating toolbar island: it tucks itself away, click any blank space to keep writing
- Export to Word / Excel / PowerPoint, with formulas delivered as **editable OMML** in DOCX — no Pandoc required
- Light and dark themes, reading palettes, Ctrl+wheel zoom
- Windows installer + portable build (no installation needed)

## Download and install

Grab the latest from the **[Releases page](https://github.com/ltmroberthk915/markpilot/releases/latest)**:

- **Windows desktop** — `markpilot-Setup-x.x.x.exe` (installer) or `markpilot-vx.x.x-portable.exe` (portable, nothing to install)
- **IDE extension** — `markpilot-x.x.x.vsix`
  - VS Code / Trae: Extensions view → `⋯` menu → **Install from VSIX…** → pick the file → reload the window
  - A MarkPilot icon appears in the activity bar; open it and add your own API key in settings for AI completion

## Latest release: v2.0.18

- **Opening a document is about a second faster** — small files went from ~1.5 s to ~0.55 s to first content, and a 200,000-character document from ~1.9 s to ~0.9 s, with no regression in switching documents, scrolling or reading-position restore.
- **Formulas inside table cells are directly editable** — click to reveal the source, edit, instant re-render; insert and delete rows/columns from the right-click menu without disturbing anything outside the table.
- **Fidelity: if you did not change something, saving changes nothing** — our test suite now asserts that a no-op edit round-trip leaves the file byte-for-byte identical, so "silently rewrote my file" bugs are caught before release.
- **More edge cases covered** — 12 packaged-build scenarios with 180 assertions, all driven through real mouse and keyboard input on the actual installer build.

See the [full release notes](https://github.com/ltmroberthk915/markpilot/releases/latest) for details.

### Fixed in v2.0.18

- **Cut from the right-click menu copied without deleting** — in some environments the system cut command reports success and puts the text on the clipboard without actually removing the selection, so "Cut" looked like it did nothing and pasting produced a duplicate. MarkPilot now verifies the selection was really removed and completes the deletion itself.
- **Table layout is re-aligned when saving** — column widths are padded and the delimiter row is recomputed. We re-checked this: after reopening, the row/column structure and every cell are identical; it is alignment normalization, not data loss. This release does not change the behaviour, it adds an automated round-trip check so it is never mistaken for a regression.

## License

The app and the extension are **free to use**, for personal and commercial work alike. Source code for the full editing core is available under a separate paid license for those who want to modify and redistribute it — open an issue in this repository to get in touch.

Binaries ship with a `THIRD-PARTY-NOTICES.md` covering bundled components.

## Privacy

Local first. Editing, rendering and exporting all happen on your machine; AI completion connects directly to the model provider you choose, only when you trigger it, and your key never leaves your computer.

---

*MarkPilot — if you find it useful, a ⭐ helps other people find it too.*
