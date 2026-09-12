# MarkPilot — AI-native Markdown editor for Windows, VS Code & Trae

**A free Typora alternative with inline AI completion, live math editing, and print-quality typography.**

[![version](https://img.shields.io/badge/version-2.1.0-blue)](https://github.com/ltmroberthk915/markpilot/releases/latest)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20VS%20Code%20%7C%20Trae-green)](https://github.com/ltmroberthk915/markpilot/releases/latest)
[![price](https://img.shields.io/badge/price-free-brightgreen)](https://github.com/ltmroberthk915/markpilot/releases/latest)
[![license](https://img.shields.io/badge/license-app%20free%20%7C%20source%20licensed-orange)](#license)

*[中文说明 / Chinese README →](README.md)*

MarkPilot is a Markdown editor built for people who write in Markdown every day: while you type one sentence, it is already drafting the next one, and underneath the text sits a real Chinese/Japanese/Korean typography engine. One editing core, two shapes — a native Windows desktop app, or an extension inside VS Code and Trae.

If you are looking for **a Typora alternative that is free**, keeps working offline, and can be extended into your AI IDE, this is the one to try.

![MarkPilot — mixed CJK/Latin typography with live math](https://raw.githubusercontent.com/ltmroberthk915/markpilot/main/docs/screenshots/hero-light-serif.png)

*A narrow window, dense wrapping, mixed Chinese/Latin text and live formulas — the serif theme (宋体-朙) with automatic CJK/Latin spacing.*

## How much faster than Typora? (measured)

Same machine, same window size, same Chinese-with-formulas document, both apps opening maximized; every row was run several times and is reported as the median. Two independent measurement methods were cross-checked and agree.

| Scenario | Measured |
| --- | --- |
| Opening a small document (1.7 KB) | MarkPilot is **~0.2 s faster** (0.51 s vs 0.71 s) |
| Opening a medium document (67 KB) | MarkPilot is **~0.14 s faster** (0.61 s vs 0.75 s) |
| Opening a large document (240 KB) | about the same (0.91 s vs 0.90 s) |
| Window appearing after a double-click | MarkPilot is **faster** (0.29 s vs 0.33 s) |
| Clicking a formula near the end of a long document to edit its LaTeX source | MarkPilot is **6.5× faster** (0.024 s vs 0.156 s) |

Compared against the current Typora of that week (1.14.10); MarkPilot numbers come from the Windows desktop build 2.0.18. Measured on 2026-09-10 — absolute times move with the machine and the document, but "opening a document is never slower, and clicking into a formula is an order of magnitude quicker" held on this machine.

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

## v2.1.5 update

### ✦ Typing after clearing the document no longer turns into a formula

Both of the items 2.1.4 left open are settled here: **one was a real defect and is fixed; the other was never a product defect — my measurement was wrong.**

Start with the gesture you verified by hand (`Ctrl+A`, then one Backspace). The body text and every formula source *were* deleted — but when the last block of the document is a display formula, Vditor keeps that formula node as the caret host and only empties its source. The Markdown then holds an empty `$$` shell **with the caret inside the source**. What 2.1.4 never measured is what happens next: typing `abc` produced `$$\nabc\n$$`, i.e. the character went into TeX and the screen showed a rendered formula instead of your text. So this was not a cosmetic leftover shell — **it was "the first sentence you type after clearing the document becomes a formula".**

Four attribution experiments (real build, real keystrokes): selecting a single formula and pressing Backspace removes 15 characters and leaves the other 196 untouched (our delete path removes one node — it is not what wiped the document); `document.execCommand('delete')`, which fires no `beforeinput` at all, still leaves the same shell; a document whose last block is a fenced code block clears to one empty paragraph with typing going to the body (so the shell is formula-specific, not generic block deletion); and WYSIWYG mode does not show the shape, so nothing there was touched.

Now the cleared document is an ordinary empty paragraph, typing goes to the body, and **one `Ctrl+Z` still restores the document byte for byte** (undo granularity was the one thing this fix could have broken, so it is pinned by its own reading).

### ✦ A correction to something I got wrong: the arrow-key step was not a defect

2.1.4 reported "1 of 8 left-arrow steps lands in the heading's `##` marker with no painted caret". What is actually true: that step's caret container was the `<h2>` **element** itself, with the offset counting *child nodes* — and Blink returns zero client rects for any collapsed range positioned on an element child boundary. Measured: putting the range at `(h2, 0)`, `(h2, 1)` and `(h2, 2)` all read zero, so the reading simply does not apply there. A magnified screenshot shows the caret plainly drawn in that frame (the vertical bar after `## 紧跟块公式的标题`). The criterion and the log were rewritten accordingly, and "collapsed range on an element boundary reads zero" is now captured as a witness so a future round does not read it as a symptom.

### ✦ Bug fixes (listed last)

1. **After clearing the whole document the caret could sit inside the emptied display-formula source, so the next characters were written as TeX** (measured on 2.1.4: typing `abc` produced `$$\nabc\n$$`). It now falls back to an empty paragraph, typing goes to the body, and one `Ctrl+Z` restores everything byte for byte.

## v2.1.4 update

### ✦ The final performance round: one measured win shipped, three candidates measured and deliberately left alone

This round started with an observation-only attribution probe (`scripts/math-edit-perf-probe.cjs`, run on the real 490 KB / 5,634-formula document) that decomposed the work done on **every** selection change — then changed only the one item that measured a real win:

- **Changed:** the expanded-node lookup moved from `querySelectorAll` to `getElementsByClassName`. Measured **0.213–0.228 ms → 0.0003–0.002 ms (570–640×)**, and a whole `refreshMathEditing` pass **0.289 ms → 0.099 ms**.
- **Measured, then deliberately not changed (numbers kept):** rewriting `ownMath` as a hand-rolled walk is *slower* (0.00010 → 0.00017 ms); a "previous character" fast path for the paragraph-edge test would save 0.0003 ms while our entire edge test costs **0.0012 ms** (0.005% of a 6.67 ms Backspace event); the enforcement `MutationObserver` only sees **0.9 records per keystroke**, so narrowing it buys nothing; the WYSIWYG full-document normalization really does cost **2.42 ms per pass**, but WYSIWYG is not the default mode and there is no reliable way to tell a freshly created formula node from an already normalized one — making it O(1) would expose every formula's source after a `setValue`. Recorded, not touched.

### ✦ The final edge round: only gestures never tested before — it found and fixed two real defects

The new `75-edge-ops-not-covered` scenario (48 assertions / 82 witnesses, **a screenshot for every check**) covers formulas at the very start and very end of a document, two formulas separated by a single blank line, formulas followed by headings and lists, `Ctrl+A` select-all, word-wise delete, arrow-key traversal across fences, double-clicking a formula, find hitting formula source, and toggling the source view. Two real defects it caught:

1. **Word-wise delete (`Ctrl+Backspace`) bypassed every boundary guard and merged a whole display formula into the preceding paragraph.** Measured on the real document: the `> (1)` line became `> (1)\neg\,\exists x\in A, P(x)\;\Leftrightarrow…`. Ctrl/Cmd + Backspace/Delete now runs through the same guard.
2. **Clicking the few pixels of page margin above the first display formula and pressing Backspace ate the last character of its source.** A click in the blank band adjacent to a collapsed formula is now mapped to before/after the formula.

## v2.1.3 update

### ✦ The gesture you verified by hand: caret before `(2)`, Backspace deletes the formula

This release reproduces that exact gesture against the **installed 2.1.2** and found three real mechanisms (each with measured numbers):

- **That "blank line" was actually a click into the hidden formula source.** A collapsed block formula keeps its source as a `0×0` shell, and Chromium resolves a click in the blank band below the rendered formula into a position *inside* that source — left side gives the source end, middle gives its start, depending on where you click. So "click once, then Backspace" deleted one character of the formula (measured: `x+y=1` → `x+y=`).
- **The paragraph-edge guard only looked at DOM siblings.** In the material, `> $$ … $$` is followed by a blank line *without* `>`, then `> (2)` — so the label and the formula live in two different block quotes. Backspace there stripped the `>` prefixes of the whole quote (measured: `> (2)` → `(2)`), which reads exactly like "the formula got deleted".
- **Clicking the `$$` fence dropped the caret into the source** (what you saw was not where the caret went), and the next Backspace then deleted source text again.

### ✦ How it behaves now

- **Clicking the blank space around a block formula** puts the caret before/after the formula: the block does not expand and the caret never lands in hidden source. Clicking the rendered formula itself still expands it and puts the caret in the source.
- **Clicking the `$$` fence** puts the caret **on the fence itself** — before the first `$`, between the two `$`, or after the last one, wherever you click. The "caret can go anywhere around the dollar signs" request is now a real position.
- **Backspace on a fence or right against a block** changes **not a single byte**, and shows a one-line notice explaining that `$$` is generated by the renderer (a single `$` cannot be deleted there) and pointing at the source view.
- **Typing / pasting / IME on a fence** sends the characters into the source on that side; fences and Markdown stay intact.
- **Additive only**: every earlier fix is kept.

### ✦ One honest note (updated numbers)

"Delete just one `$`, like source editing" is not possible in the rendered view, and this round measured what it would cost: a real Markdown change makes Lute re-pair the fences (measured: after rewriting the closing fence to a single `$`, the following `> (2)` line was swallowed into the formula source), and Markdown can only be changed by reparsing the whole document — 24 ms for a 20 KB file but **2.0–2.2 s for a 481 KB one**, and the round trip is not even byte-identical. So the choice here is "the fence is a real caret position, Backspace changes nothing, and the reason is shown on the spot"; to delete fence characters one by one, use the source view (toolbar "切换源码视图").

## v2.1.2 update

### ✦ The two fixes 2.1.1 only claimed — now actually verified against the shipped build

After installing 2.1.1 you reported that none of the fixes worked. Re-testing the installed build with real mouse and keyboard input, that verdict was correct: two and a half of the 2.1.1 fixes were no-ops (the expand-state reclaim ran before Vditor added the class; the boundary check did not recognise element-level caret positions; "select the whole formula first" was not the behaviour you asked for). This release redoes them your way:

- **Backspace next to a formula no longer changes a single byte.** Previously a press at the edge of a block formula dissolved `$$…$$` into the previous paragraph; 2.1.1 merely turned that into "first press selects the whole formula, second deletes it", so two presses still destroyed it. Now the press only moves the caret to the nearest text outside the formula — the document is untouched — and the next press deletes ordinary text outside it.
- **The `$$` fences put the caret where you click.** Click the opening `$$` and the caret goes to the start of the source; click the closing one and it goes to the end. Characters you then type really land on that side (before, typing with the caret parked on a fence silently appended to the end of the source).
- **The preview box can no longer linger at a line end.** The expanded state is now enforced structurally: if the caret is not in the formula's source or preview, the expanded class is removed immediately, instead of racing Vditor with a single retry (which is why 2.1.1 behaved differently on different attempts).
- Everything else from 2.1.1 stays: selecting a whole formula and deleting it leaves no `<span>` residue, and `Ctrl+B/I/U` or Enter inside TeX source no longer corrupts it.

### ✦ One honest limitation

Your report held up "source editing only deletes the last `$`" as the expected behaviour. The `$$` of a block and the `$` of an inline formula are markers Vditor regenerates on every re-parse; "delete one `$`" is not an editable action in the IR (editing marker text is discarded). This release therefore chooses **not to change the document at all** on a boundary press, rather than pretending to delete a `$` and leaving half a formula behind. To delete a formula deliberately, select the whole thing and press `Backspace`/`Delete` — that path is still clean.

## Fixes (v2.1.2)

- Element-level caret containers (`code[data-type="math-block"]@0`, the shape Chromium produces when you click a formula body) were not recognised as boundaries, so one Backspace dissolved the whole `$$…$$` block into the previous paragraph: `formulaEdge` now covers element-level positions (the source element itself and the fence markers).
- Boundary Backspace no longer selects the whole formula; it moves the caret to the nearest text outside the formula and leaves the document unchanged.
- The expanded state is now enforced with a `MutationObserver` (removed whenever the caret is not in the formula's source/preview), removing the timing race behind the intermittent preview box.
- Fence clicks have defined semantics: opening `$$` → caret at source start, closing `$$` → caret at source end (before, clicking the closing fence dropped the caret into the next paragraph).
- Backspace at position 0 of an inline formula's source is now intercepted too (the v2.0.4 "formula disappears" shape was still reachable for inline math).
- Measured cost (same-session A/B): observer connected vs disconnected, 51.7/50.7 ms vs 53.2/52.6 ms per keystroke, minimum 41 vs 40 ms — within noise.

## v2.1.1 update

### ✦ Editing next to a formula now behaves the way you expect

All three come from reports made in a real document:

- **A line that ends with a formula no longer pops the preview box when you put the caret at the end of the line.** Before, clicking at the line end (or pressing End) made the last formula's floating preview appear over the text below. Now only **clicking the formula itself** expands its source for editing; before/after the formula are ordinary caret positions, and typing there lands after the formula.
- **The `$$` of a `$$ … $$` block are real, clickable text now.** Previously, however you clicked, the caret could only land at the very first position of the source (the two `$$` were drawn by pseudo-elements and were not part of the document). They can now be clicked, selected and edited character by character.
- **Backspace next to a formula no longer destroys it.** At a block's edge — its start, its end, or the paragraph right before/after it — one Backspace used to dissolve `$$…$$` into a plain line of text, or silently eat characters out of the source. The first press now only **selects the whole formula** (the document does not change); a second press deletes it as one unit, so removing a formula is still two keystrokes.

### ✦ Three related problems found while testing

- **Ctrl+B / Ctrl+I / Ctrl+U inside formula source** no longer inserts `****`, `**` or `<u></u>` into the TeX (which broke the formula instantly). Clipboard, undo/redo and select-all are unaffected.
- **Enter inside an inline formula's source** no longer splits the TeX (it used to produce garbage such as `$a$a+1+1$`). The caret simply moves out of the formula; block formulas keep their multi-line source, so Enter still inserts a newline there.
- **Deleting a whole formula** (whether you selected it yourself or the step above selected it) no longer leaves stray `<span>` text behind.

## Fixes (v2.1.1)

- A line ending in a formula had its last formula auto-expanded by Vditor (the node under the caret), which floated the preview box: a boundary caret no longer counts as editing the formula, and an expansion Vditor added is now reclaimed.
- The `$$` of a block formula were `::before/::after` pseudo-elements, which never take part in hit testing, so every click landed at source offset 0: the expanded state now uses the real `$$` text nodes (the pseudo-elements are turned off so the fence is not drawn twice), while the collapsed state still shows only the rendered result.
- With the caret as a direct child position of a node's start/end (Chromium's usual landing spot at a line end), Backspace ate the trailing `$` and turned the formula into literal text: such boundary positions now select the whole formula first.
- Backspace at the start of a block formula's source removed the `$$` fence (the whole block collapsed into one line of text), and Delete at the end of an inline formula's source erased the formula: deletion towards the fence now selects the whole formula first, while normal editing **inside** the source (Backspace at the end, Delete at the start) is left untouched.
- Delete with the caret at the start/end of the paragraph next to a block formula merged the formula into that paragraph's text: it now selects the whole formula first.
- `Ctrl+B` / `Ctrl+I` / `Ctrl+U` inside formula source inserted Markdown markers into the TeX: formatting shortcuts no longer apply inside formula source.
- Enter inside an inline formula's source split the TeX and duplicated half of the formula: it now only moves the caret out of the formula and leaves the document unchanged.

## v2.1.0 update

### ✦ Several documents at once: one file, one window

Opening a second file used to **replace** the one already open — the most important defect in the product. Every file now gets its own window: move, resize and maximise them independently, close one without disturbing the others, and only get asked about unsaved work when you close a window or quit — **one prompt per window**, and cancelling aborts the whole quit (nothing already confirmed is lost).

Also part of this:

- **One window per file** — opening a file that is already open brings that window forward instead of creating a second copy that fights over the same file.
- **Your session comes back** — which files were open, their folders, positions and sizes are remembered.
- **A folder tree per window** — windows can sit in different folders without dragging each other along, and a folder is watched once no matter how many windows show it.
- **Drop or select several files** — each opens in its own window; an empty welcome window is reused first instead of being wasted.

### ✦ The toolbar gets out of the way in a small window

Squeeze the window and the toolbar wraps until it eats a large share of the height. Once it takes 35% or more of the visible height it **tucks itself away**; move the pointer to the top edge and it slides back out, move away and it retracts, so the text always keeps the full height. Back at a normal size nothing changes. (In a very small window we measured 116%.)

The window can no longer be squeezed shorter than the toolbar either: the **minimum height follows the toolbar's real height after wrapping** (so the toolbar never takes more than 80% of the visible height). Narrow the window and the wrapped toolbar grows, which raises the minimum height; widen it again and the minimum drops back with it — it tracks the actual layout, not a hard-coded number.

### ✦ No more "one file at a time" in the IDE

- Tabs are **pinned by default** — a single click used to reuse the same preview tab; every file now gets its own tab.
- A new context-menu command, "**Open with MarkPilot (new tab)**", forces a new tab under any settings.
- Switching back to a tab re-syncs the editor with the latest content, so a tab that sat in the background no longer shows stale text.

### Fixed in v2.1.0

- **The toolbar could swallow half of a small window** — see above: it tucks away past 35%, slides out at the top edge, retracts on leave.
- **A background tab could show stale content** — hidden webviews are not guaranteed to receive updates; returning to a tab now re-syncs once, and does nothing when the content already matches, so undo history is not thrown away.
- **A dialog could stay behind and never reopen** — when a window is fully covered by another, a `<dialog>` close event may never fire, leaving the node in the page and blocking the id check that guards reopening. Closing now cleans up after itself.
- **An occasional error dialog when quitting** — with several windows open, teardown focus callbacks could read a destroying window; those callbacks are now skipped.
- **Opening several files left only one window** — the second file was mistaken for "fill the window that was just created", so the files piled into one window: the same "replaces the previous one" symptom in a new shape.
- **Copying a rich table between two windows dropped the formatting** — copying cells with bold text or inline code silently lost the markers, so the pasted side was plain text. Cells are now serialised cell by cell, and bold, formulas, inline code, images and escaped pipes all survive and render again as real nodes in the other window.
- **Cutting table cells between two windows pasted one run-on string** — the clipboard received the selected cells concatenated (and the table shape could be damaged), so pasting into the other window produced a single cell. Cutting now uses the same rectangle semantics as copying, clearing only the selected cells and leaving the shape intact.
- **Cutting an image between two windows pointed at the source folder** — the cut image was pasted as a reference to the *original document's* directory, which breaks in the other document. A cut image is now placed on the clipboard as an image, so it belongs to whichever document you paste it into.

## v2.0.20 update

- **Export now asks where to save, and shows you the file afterwards** — Export moved out of the overflow menu onto the toolbar as its own button. Pick PDF / Word / HTML / portable Markdown, choose the destination in a save dialog, and the finished file is revealed in Explorer automatically. The button carries no text: it uses the standard "box with an arrow leaving it" export glyph, so it reads the same in any language, and the four formats plus the save-first behaviour live in the hover tooltip.
- **The toolbar no longer carries buttons that pretend to work** — a handful of entries that did nothing, or actively misbehaved, are gone. See the fixes below.
- **The mouse back/forward side buttons no longer blank the editor** — pressing Back used to wipe the whole editing area until you pressed Forward.

### Fixed in v2.0.20

- **Exporting to PDF left you with no idea where the file went** — the overflow menu used to contain *two* Export entries: ours (an unlabelled icon) and the one bundled with the editor core (labelled "Export", and the only one offering PDF). Choosing PDF there showed a "generating" toast and produced nothing at all — it wrote into a zero-height hidden frame and invoked the system print command. Markdown and HTML quietly downloaded into the system Downloads folder instead. That entry is gone, Export is now a top-level icon button, and a successful export reveals the file for you. The export engine itself was always fine: PDF, Word, HTML and portable Markdown are all verified byte-for-byte.
- **Mouse side buttons wiped the editing area** — with a mouse that has back/forward buttons, pressing Back made the whole editor disappear until Forward brought it back. Each document is loaded into an internal frame, and every load pushed a browser-history entry, so Back navigated that frame to a previous document or a blank page. Back and Forward side buttons (and the Alt+←/→ chords that mouse drivers often map them to) are now intercepted; middle-click and right-click are untouched.
- **The record button was a trap, and is removed** — it appeared to record audio: it really did take the microphone, then handed the audio to the *image* pipeline, failed with an "unsupported image format" message, and saved the recording nowhere. Worse, it left the editing surface read-only, so after two clicks the document could no longer be typed into. The feature was never actually wired up, so it has been taken out.
- **The About box described someone else's project** — it used to show the editor core's own open-source blurb, complete with links to its website and forum, and Help linked to that same third-party documentation site. About now shows MarkPilot's own version and repository; Help points at our GitHub repository.

## v2.0.18 update

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
