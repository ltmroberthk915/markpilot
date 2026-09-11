# MarkPilot — AI-native Markdown editor for Windows, VS Code & Trae

**A free Typora alternative with inline AI completion, live math editing, and print-quality typography.**

[![version](https://img.shields.io/badge/version-2.0.18-blue)](https://github.com/ltmroberthk915/markpilot/releases/latest)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20VS%20Code%20%7C%20Trae-green)](https://github.com/ltmroberthk915/markpilot/releases/latest)
[![price](https://img.shields.io/badge/price-free-brightgreen)](https://github.com/ltmroberthk915/markpilot/releases/latest)
[![license](https://img.shields.io/badge/license-app%20free%20%7C%20source%20licensed-orange)](#license)

*[中文说明 / Chinese README →](README.md)*

MarkPilot is a Markdown editor built for people who write in Markdown every day: while you type one sentence, it is already drafting the next one, and underneath the text sits a real Chinese/Japanese/Korean typography engine. One editing core, two shapes — a native Windows desktop app, or an extension inside VS Code and Trae.

If you are looking for **a Typora alternative that is free**, keeps working offline, and can be extended into your AI IDE, this is the one to try.

![MarkPilot — mixed CJK/Latin typography with live math](https://raw.githubusercontent.com/ltmroberthk915/markpilot/main/docs/screenshots/hero-light-serif.png)

*A narrow window, dense wrapping, mixed Chinese/Latin text and live formulas — the serif theme (宋体-朙) with automatic CJK/Latin spacing.*

## Screenshots

| | |
|---|---|
| **Click a symbol, edit its source** — click ω and the caret lands on the `o` of `\omega` | **…or click a subscript** — click the `n` of `f_n` and the caret lands on that very `n` |
| ![Click omega](https://raw.githubusercontent.com/ltmroberthk915/markpilot/main/docs/screenshots/math-map-omega.png) | ![Click subscript](https://raw.githubusercontent.com/ltmroberthk915/markpilot/main/docs/screenshots/math-map-subscript.png) |
| **Interface opacity** — every popup and the toolbar are translucent, with separate sliders (10–100%) | **Typography** — serif themes, CJK/Latin spacing, optimal line breaking |
| ![Translucent context menu](https://raw.githubusercontent.com/ltmroberthk915/markpilot/main/docs/screenshots/menu-translucent-70.png) | ![Dense wrapping](https://raw.githubusercontent.com/ltmroberthk915/markpilot/main/docs/screenshots/body-dense-wrapping.png) |

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

Rendered math, Typora-style: you see the formula, and when the caret comes near, the relevant source appears for editing with instant preview. MarkPilot goes further and maps the rendered output back to the source — **click any symbol in a formula and the caret lands exactly on the source that produced it** (click ω → the caret sits on the `o` of `\omega`; click the subscript `n` → it sits on that `n`). The mapping survives formulas inside table cells and nested blocks, with precise undo/redo. Formulas stop being "pictures you can't touch" and become live, editable content.

### ✦ Translucent surfaces you control

Every popup, menu and the toolbar are translucent by default, and **Interface opacity** gives you independent sliders (10–100%) for popups and for the toolbar — 70% is a good starting point. Adjustable rather than baked in: readable when you want it, glassy when you don't.

### ✦ The editor moves into your AI IDE

The whole editing core ships as a standard extension: install the VSIX in VS Code or Trae and a Markdown workbench appears in the activity bar — full editor, outline tree, AI completion, all running natively inside the IDE. Write documentation in your AI IDE without switching windows.

### ✦ Large files that stay smooth

Chunked background rendering with source-cache reuse: open a big document, keep typing, undo, jump through the outline — it stays responsive even with thousands of formulas. In our own measurements, the CPU cost of editing dropped by 57–87%.

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

**IDE extension** — search `MarkPilot` in your editor's extension view:

- **VS Code** — install from the Marketplace (ID `Jinxi.markpilot`) → <https://marketplace.visualstudio.com/items?itemName=Jinxi.markpilot>
- **Trae / Cursor / VSCodium** — from Open VSX (ID `jinxi.markpilot`) → <https://open-vsx.org/extension/jinxi/markpilot>
  - If your editor does not show it yet, use the manual install below
- **Manual** — download `markpilot-x.x.x.vsix` from the **[Releases page](https://github.com/ltmroberthk915/markpilot/releases/latest)**
  - VS Code / Trae: Extensions view → `⋯` menu → **Install from VSIX…** → pick the file → reload the window
  - A MarkPilot icon appears in the activity bar; open it and add your own API key in settings for AI completion

**Windows desktop** — from the **[Releases page](https://github.com/ltmroberthk915/markpilot/releases/latest)**:

- `markpilot-Setup-x.x.x.exe` (installer) or `markpilot-vx.x.x-portable.exe` (portable, nothing to install)

## Latest release: v2.0.18

- **Opening a document is about a second faster** — small files go from ~1.5 s to ~0.55 s to first content, and a 200,000-character document from ~1.9 s to ~0.9 s.
- **Formulas inside table cells are directly editable** — click to reveal the source, edit, instant re-render; insert and delete rows and columns from the right-click menu.
- **Saving does not quietly rewrite your document** — text you did not touch comes back out character for character.

See the [full release notes](https://github.com/ltmroberthk915/markpilot/releases/latest) for details.

### Fixed in v2.0.18

- **Cut from the right-click menu did nothing in some environments** — it copied the text but left it in the document, so pasting produced a duplicate. Cut now really removes what you selected.
- **Table rows and columns stay intact after saving** — saving re-aligns table layout, and every cell comes back exactly as it was.

## License

The app and the extension are **free to use**, for personal and commercial work alike. Source code for the full editing core is available under a separate paid license for those who want to modify and redistribute it — open an issue in this repository to get in touch.

Binaries ship with a `THIRD-PARTY-NOTICES.md` covering bundled components.

## Privacy

Local first. Editing, rendering and exporting all happen on your machine; AI completion connects directly to the model provider you choose, only when you trigger it, and your key never leaves your computer.

---

*MarkPilot — if you find it useful, a ⭐ helps other people find it too.*
