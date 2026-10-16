// Actual Windows bitmap clipboard, trusted input, pixels, files and editor state.
"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { args, launch, acquireSlot, sleep, sha256 } = require("./lifecycle.cjs");
const { outputDir, snapshot, reset, frame, newWindow, newBlankWindow, recorder, waitUntil } = require("./harness.cjs");
const { bitmap, verifyBitmap, verifyText } = require("./clipboard.cjs");
(async () => {
  const argv = process.argv.slice(2);
  const delayAt = argv.indexOf('--image-delay-ms');
  let imageDelayMs = 5000;
  if (delayAt >= 0) {
    imageDelayMs = Number(argv[delayAt + 1]);
    assert(Number.isInteger(imageDelayMs) && imageDelayMs >= 0 && imageDelayMs <= 5000, 'Image delay must be 0..5000 ms');
    argv.splice(delayAt, 2);
  }
  const caseAt = argv.indexOf('--case');
  let only;
  if (caseAt >= 0) {
    only = argv[caseAt + 1];
    argv.splice(caseAt, 2);
    assert(only, "--case needs an id");
  }
  const o = args(argv), dir = outputDir(o.out, "images"), release = acquireSlot();
  const docDir = path.join(dir, "\u4E2D\u6587 \u622A\u56FE #%()/v3.2.5"), doc = path.join(docDir, "\u65B0\u5EFA Markdown \u6587\u6863.md"), other = path.join(dir, "other.md"), saveImage = path.join(dir, "saved-image.bin");
  fs.mkdirSync(docDir, { recursive: true });
  fs.writeFileSync(doc, "\u56FE\u7247\u6D4B\u8BD5\n");
  fs.writeFileSync(other, "OTHER DOCUMENT\n");
  const result = { schema: 1, startedAt: (/* @__PURE__ */ new Date()).toISOString(), cases: [], frames: [], observations: [] }, record = recorder(dir, result);
  const check = (id, body) => !only || only === id ? record(id, async (trace) => {
    try {
      return await body(trace);
    } catch (e) {
      if (p) {
        trace.push({ failureState: await state().catch(() => null), images: await images().catch(() => null), toast: await p.evaluate(() => document.querySelector(".mp-toast")?.textContent).catch(() => null) });
        await capture("failed-" + id).catch(() => {
        });
      }
      throw e;
    }
  }) : Promise.resolve();
  let run, clip, p, fixtureA, fixtureB;
  const capture = async (name, page = p) => result.frames.push(await frame(page, dir, name));
  const state = async (page = p) => {
    const s = await snapshot(page);
    return { ...s, text: s.text.replace(/(data:image\/[^,]*,)[A-Za-z0-9+/=]+/g, "$1[bitmap bytes omitted]") };
  };
  const images = (page = p) => page.evaluate(() => [...document.querySelectorAll(".cm-content .mp-img img")].map((i) => ({ src: i.getAttribute("src")?.slice(0, 160), complete: i.complete, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight, width: i.getBoundingClientRect().width, failed: !!i.closest(".is-failed") })));
  const decoded = (page = p) => waitUntil(async () => (await images(page)).some((i) => i.complete && i.naturalWidth === 1369 && !i.failed), "immediate screenshot decode", 1e4);
  const setClipboard = async (file) => {
    if (clip) {
      await clip.restore();
      clip = null;
    }
    clip = await bitmap(file);
    assert(verifyBitmap(file).matches, "independent process verifies clipboard pixels before input");
  };
  const paste = async (file = fixtureA, page = p) => {
    assert((await snapshot(page)).focus, "editor owns keyboard focus");
    assert(verifyBitmap(file).matches, "clipboard still contains this screenshot");
    await page.keyboard.press("Control+v");
    assert(verifyBitmap(file).matches, "clipboard pixels unchanged after trusted Ctrl+V");
  };
  const imageMenu = async (label, page = p, index = 0) => {
    const img = page.locator(".cm-content .mp-img img").nth(index);
    await img.scrollIntoViewIfNeeded();
    await sleep(200);
    // Use a visible image pixel. A short image may have its centre underneath
    // the recovery banner; locator.click would scroll again during the gesture,
    // so its queued scroll event legitimately closes the newly opened menu.
    const point = await img.evaluate(i => {
      const r=i.getBoundingClientRect(),sc=i.closest('.cm-scroller').getBoundingClientRect(),x=r.left+r.width/2;
      let top=Math.max(r.top,sc.top+4),bottom=Math.min(r.bottom,sc.bottom,innerHeight-8);
      for(const e of document.querySelectorAll('#mp-banner,.mp-toolbar')){
        const b=e.getBoundingClientRect();
        if(b.width&&b.height&&x>=b.left&&x<=b.right&&b.top<=top+4)top=Math.max(top,b.bottom+2);
      }
      const y=(top+bottom)/2;
      if(bottom-top<4||document.elementFromPoint(x,y)!==i)throw Error('Image context menu must start on an unobscured image pixel');
      return{x,y};
    });
    await page.mouse.click(point.x,point.y,{button:'right',delay:65});
    await page.locator(".mp-pop-menu").waitFor({ state: "visible" });
    await page.locator(".mp-pop-menu .mp-pop-item").filter({ hasText: new RegExp("^" + label + "$") }).click();
    await sleep(150);
  };
  const reopen = async (file) => {
    const r = await p.evaluate((file2) => window.mpHost.openPath(file2), file);
    assert(r.ok, "open owned fixture: " + JSON.stringify(r));
    await waitUntil(() => p.evaluate((file2) => window.mpHost.docInfo().then((d) => d.filePath === file2), file), "document ownership");
    await sleep(180);
  };
  try {
    run = await launch(o, doc, dir, { MP_TEST_IMAGE_SAVE_AS: saveImage, MP_TEST_IMAGE_DELAY_MS: String(imageDelayMs), MP_TEST_REPLACE_RESPONSE: 'discard' });
    p = run.page;
    result.metadata = run.metadata;
    result.metadata.imageHostDelayMs = imageDelayMs;
    for (const [id, color] of [["a", "#e4f3fd"], ["b", "#f8dcd7"]]) {
      const base64 = await p.evaluate(({ color: color2, id: id2 }) => {
        const c = document.createElement("canvas");
        c.width = 1369;
        c.height = 857;
        const x = c.getContext("2d");
        x.fillStyle = color2;
        x.fillRect(0, 0, c.width, c.height);
        x.fillStyle = "#1769a5";
        x.fillRect(30, 30, 1309, 180);
        x.fillStyle = "#fff";
        x.font = "70px sans-serif";
        x.fillText("SCREENSHOT " + id2.toUpperCase(), 65, 155);
        x.fillStyle = "#e45636";
        x.fillRect(90, 320, 490, 370);
        x.fillStyle = "#39a46d";
        x.fillRect(730, 320, 490, 370);
        return c.toDataURL("image/png").split(",")[1];
      }, { color, id });
      const file = path.join(dir, "screenshot-" + id + ".png");
      fs.writeFileSync(file, Buffer.from(base64, "base64"));
      if (id === "a") fixtureA = file;
      else fixtureB = file;
    }
    await setClipboard(fixtureA);
    await p.evaluate(() => {
      window.__imagePastes = [];
      document.addEventListener("paste", (e) => window.__imagePastes.push({ trusted: e.isTrusted, types: [...e.clipboardData.types], files: [...e.clipboardData.files].map((f) => ({ type: f.type, size: f.size })) }), true);
    });
    const assetA = path.join(docDir, "assets", "fixture-a.png");
    fs.mkdirSync(path.dirname(assetA), { recursive: true });
    fs.copyFileSync(fixtureA, assetA);
    await check("saved-screenshot-immediate", async (trace) => {
      const text = "# \u56FE\u7247\n\n\u6B63\u6587\n";
      await reset(p, text, text.length);
      await capture("before-paste");
      const start = performance.now();
      await paste();
      await decoded();
      const s = await snapshot(p);
      trace.push({ state: await state(), images: await images(), ms: Math.round(performance.now() - start), event: await p.evaluate(() => window.__imagePastes.at(-1)) });
      await capture("immediate-assets");
      const rel = /!\[\]\((assets\/[^)]+)\)/.exec(s.text)?.[1];
      assert(rel);
      assert(fs.existsSync(path.join(docDir, decodeURIComponent(rel))));
      assert(s.selection.head === s.text.length, "caret remains at paste endpoint");
      assert(trace[0].event.trusted);
    });
    await check("long-document-paste-is-visible-without-extra-input", async (trace) => {
      const fixture = path.join(dir, "small-screenshot.png");
      const bytes = await p.evaluate(() => {
        const c = document.createElement('canvas'); c.width = 400; c.height = 160;
        const x = c.getContext('2d'); x.fillStyle = '#e4f3fd'; x.fillRect(0, 0, 400, 160);
        x.fillStyle = '#1769a5'; x.fillRect(15, 15, 370, 65);
        x.fillStyle = '#fff'; x.font = '25px sans-serif'; x.fillText('PASTE AT DOCUMENT END', 25, 55);
        x.fillStyle = '#e45636'; x.fillRect(25, 100, 150, 35);
        x.fillStyle = '#39a46d'; x.fillRect(225, 100, 150, 35);
        return c.toDataURL('image/png').split(',')[1];
      });
      fs.writeFileSync(fixture, Buffer.from(bytes, 'base64'));
      const padded = Buffer.concat([fs.readFileSync(fixtureA), Buffer.alloc(280000)]).toString('base64');
      const text = Array.from({length: 24}, (_, i) => '# Section ' + i + '\n\n<img src="data:image/png;base64,' + padded + '" width="756" />\n\n' + 'ordinary paragraph before screenshot\n'.repeat(5)).join('') + '\n';
      await setClipboard(fixture);
      await reset(p, text, text.lastIndexOf(' />') + 3);
      await capture('long-document-before-paste');
      assert(verifyBitmap(fixture).matches, 'Own bitmap before navigation and immediate paste');
      await p.keyboard.press('Control+End');
      assert.equal((await snapshot(p)).selection.head, text.length);
      await p.keyboard.press('Control+v');
      assert(verifyBitmap(fixture).matches, 'Own bitmap after immediate paste');
      await waitUntil(() => p.evaluate(() => [...document.querySelectorAll('.mp-img img')].some(i => i.complete && i.naturalWidth === 400 && i.naturalHeight === 160)), 'small screenshot decoded');
      const geometry = () => p.evaluate(() => {
        const v = window.mpEngine._view(), scroll = v.scrollDOM.getBoundingClientRect();
        const footer = document.querySelector('.mp-statusbar')?.getBoundingClientRect();
        const image = [...v.contentDOM.querySelectorAll('.mp-img img')].find(i => i.naturalWidth === 400);
        const r = image?.getBoundingClientRect();
        return { top: r?.top, bottom: r?.bottom, visibleBottom: Math.min(scroll.bottom, footer?.top ?? scroll.bottom), scrollTop: v.scrollDOM.scrollTop, caret: v.coordsAtPos(v.state.selection.main.head) };
      });
      trace.push({phase: 'decoded', ...await geometry()});
      await waitUntil(async () => { const g = await geometry(); return g.top >= 70 && g.bottom <= g.visibleBottom; }, 'entire screenshot visible without any post-paste input', 3000);
      trace.push({phase: 'settled', ...await geometry()});
      await capture('long-document-immediate-paste');
      trace.push({fixtureBytes: Buffer.byteLength(text), imageHostDelayMs: imageDelayMs});
      await setClipboard(fixtureA);
    });
    for (const pos of ["start", "end"]) await check("image-" + pos + "-boundary", async (trace) => {
      const text = "![](assets/fixture-a.png)";
      await reset(p, text, pos === "start" ? 0 : text.length);
      await decoded();
      trace.push({ state: await state(), images: await images() });
      await capture("boundary-" + pos);
    });
    await check("ordinary-character-delete-creates-image", async (trace) => {
      const text = "![x]X(assets/fixture-a.png)\n\n\u6B63\u6587";
      await reset(p, text, 5);
      await p.keyboard.press("Backspace");
      assert((await snapshot(p)).text.startsWith("![x]("));
      await p.keyboard.press("Control+End");
      await decoded();
      trace.push({ state: await state(), images: await images() });
      await capture("candidate-delete");
    });
    await check("source-address-remains-editable-inside", async (trace) => {
      const text = "![](assets/fixture-a.png)";
      await reset(p, text, 0);
      await p.keyboard.press("ArrowRight");
      const addressInside = text.indexOf('assets/') + 3;
      while((await snapshot(p)).selection.head < addressInside) await p.keyboard.press('ArrowRight');
      const active = await snapshot(p);
      assert(active.focus && active.selection.head === addressInside, "native interior caret owns the literal address");
      assert((await images()).length === 1, "source editing retains preview");
      assert(await p.locator('.cm-content .cm-line').filter({hasText:'assets/fixture-a.png'}).count(), "short literal address is visible in native source");
      await p.keyboard.press('R');
      const edited = text.slice(0, active.selection.head) + 'R' + text.slice(active.selection.head);
      assert.equal((await snapshot(p)).text, edited, 'trusted input edits the literal address owner');
      await p.keyboard.press('Control+z'); assert.equal((await snapshot(p)).text, text);
      await p.keyboard.press('Control+y'); await p.keyboard.press('1');
      assert.equal((await snapshot(p)).text, text.slice(0, active.selection.head)+'R1'+text.slice(active.selection.head), 'native history and immediate continuation');
      trace.push(await state());
      await capture("source-interior");
    });
    await check("inline-screenshot-immediate", async (trace) => {
      const text = "---\nmp-image-mode: inline\n---\n\n\u6B63\u6587\n";
      await reset(p, text, text.length);
      await paste();
      await decoded();
      assert((await snapshot(p)).text.includes("data:image/png;base64,"));
      trace.push({ state: await state(), images: await images() });
      await capture("immediate-inline");
    });
    await check("selection-replacement-undo-redo", async (trace) => {
      await reset(p, "before SELECT after", 7, 13);
      await paste();
      trace.push({ phase: "initial-paste", state: await state(), images: await images() });
      await decoded();
      const inserted = (await snapshot(p)).text;
      assert(inserted.startsWith("before ![](assets/"));
      assert(inserted.endsWith(" after"));
      const afterSelection = (await snapshot(p)).selection;
      await p.keyboard.press("Control+z");
      assert.equal((await snapshot(p)).text, "before SELECT after");
      assert.deepEqual((await snapshot(p)).selection, {anchor:7,head:13}, 'Undo restores directed replacement range');
      await p.keyboard.press("Control+y");
      assert.equal((await snapshot(p)).text, inserted);
      assert.deepEqual((await snapshot(p)).selection, afterSelection, 'shared CM history restores insertion after-state');
      const token = inserted.slice(7, inserted.length - ' after'.length);
      await p.keyboard.down('Shift');
      try { for(let n=0;n<token.length && (await snapshot(p)).selection.head>7;n++) await p.keyboard.press('ArrowLeft'); }
      finally { await p.keyboard.up('Shift'); }
      const s = await snapshot(p), selected = inserted.slice(Math.min(s.selection.anchor, s.selection.head), Math.max(s.selection.anchor, s.selection.head));
      assert.equal(selected, token, "real modified keys select the complete inserted source");
      await p.keyboard.press("Control+c");
      assert(verifyText(selected).matches);
      trace.push({ phase: "redo-native-selection", state: await state(), images: await images() });
      await p.keyboard.press("ArrowRight");
      await decoded();
      await capture("undo-redo");
      await setClipboard(fixtureA);
    });
    await check("paste-keeps-origin-while-typing", async (trace) => {
      await reset(p, "before  after", 7);
      await p.keyboard.press("Control+v");
      await p.keyboard.insertText("TYPED");
      await decoded();
      const s = await snapshot(p);
      assert(s.text.includes(")TYPED after"), "typed text stays after original paste location");
      trace.push({ state: await state(), images: await images() });
      await capture("typing-during-write");
    });
    await check("paste-replaced-selection-is-canceled", async (trace) => {
      await reset(p, "before SELECT after", 7, 13);
      await p.keyboard.press("Control+v");
      await p.keyboard.insertText("REPLACED");
      await sleep(5600);
      assert.equal((await snapshot(p)).text, "before REPLACED after");
      trace.push(await state());
      await capture("selection-canceled");
    });
    await check("same-text-reload-cancels-pending-image", async (trace) => {
      const text = "same document\n";
      await reset(p, text, text.length);
      await p.keyboard.press("Control+v");
      await p.evaluate((text2) => window.mpEngine.setValue(text2), text);
      await sleep(5600);
      assert.equal((await snapshot(p)).text, text);
      trace.push(await state());
      await capture("same-text-canceled");
    });
    await check("switch-document-cancels-pending-image", async (trace) => {
      await reset(p, "origin\n", 7);
      await p.keyboard.press("Control+v");
      await reopen(other);
      await sleep(5500);
      assert.equal((await snapshot(p)).text, "OTHER DOCUMENT\n");
      trace.push(await state());
      await capture("switch-canceled");
      await reopen(doc);
    });
    await check("two-pastes-keep-request-order", async (trace) => {
      await reset(p, "AB\n", 0);
      await p.keyboard.press("Control+v");
      await setClipboard(fixtureB);
      assert.equal((await snapshot(p)).text, "AB\n", "first image is still pending when second paste begins");
      await p.keyboard.press("Control+v");
      assert(verifyBitmap(fixtureB).matches, "second clipboard screenshot pixels after input");
      await waitUntil(() => p.evaluate(() => window.mpEngine.__inlineMarks().filter((m) => m.kind === "image").length === 2), "two image insertions", 15e3);
      const s = await snapshot(p), refs = [...s.text.matchAll(/!\[\]\((assets\/[^)]+)\)/g)].map((m) => m[1]);
      assert.equal(refs.length, 2);
      const a = fs.readFileSync(path.join(docDir, decodeURIComponent(refs[0]))), b = fs.readFileSync(path.join(docDir, decodeURIComponent(refs[1])));
      assert.notDeepEqual(a, b, "different screenshots remain different");
      await waitUntil(() => p.evaluate(() => [...document.querySelectorAll(".mp-img img")].length === 2 && [...document.querySelectorAll(".mp-img img")].every((i) => i.complete && i.naturalWidth)), "both screenshot pixels");
      const pixels = await p.evaluate(() => [...document.querySelectorAll(".mp-img img")].map((i) => {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const x = c.getContext("2d");
        x.drawImage(i, 0, 0);
        return [...x.getImageData(0, 0, 1, 1).data];
      }));
      assert.deepEqual(pixels, [[228, 243, 253, 255], [248, 220, 215, 255]]);
      trace.push({ state: await state(), refs, pixels, hashes: [crypto.createHash("sha256").update(a).digest("hex"), crypto.createHash("sha256").update(b).digest("hex")] });
      await capture("two-pastes");
      await setClipboard(fixtureA);
    });
    await check("undo-cancels-pending-image", async (trace) => {
      const file = path.join(dir, "fresh-history-undo.md");
      fs.writeFileSync(file, "CANCEL\n");
      const q = await newWindow(run, p, file);
      await reset(q, "CANCEL\n", 7);
      await paste(fixtureA, q);
      assert.equal((await snapshot(q)).text, "CANCEL\n", "image write is still pending before no-op undo");
      await q.keyboard.press("Control+z");
      await sleep(5500);
      assert.equal((await snapshot(q)).text, "CANCEL\n", "no-op undo cancels the image without resurrecting another fixture's history");
      trace.push(await state(q));
      await capture("undo-pending", q);
      await q.evaluate(() => window.mpHost.docDirty(false)); await q.close(); await p.bringToFront();
    });
    for (const syntax of ["![x](assets/a(b).png)", '<img src="assets/fixture-a.png" height="80" alt="a>b">']) await check("delete-image-" + (syntax.startsWith("<") ? "html" : "balanced-url"), async (trace) => {
      fs.copyFileSync(fixtureA, path.join(docDir, "assets", "a(b).png"));
      const text = syntax + "\n\n\u6B63\u6587";
      await reset(p, text, text.length);
      await decoded();
      await imageMenu("\u5220\u9664\u56FE\u7247");
      const deleted = "\n\n\u6B63\u6587", afterDelete = await snapshot(p);
      trace.push({ afterDelete: await state(), commandTrace: await p.evaluate(() => window.mpEngine._view().__mpCommandTrace) });
      assert.equal(afterDelete.text, deleted, 'menu removes the complete literal image token');
      assert(afterDelete.focus, 'image source command returns keyboard focus to the editor');
      await capture('deleted-' + (syntax.startsWith('<') ? 'html' : 'balanced-url'));
      await p.keyboard.press("Control+z");
      const undone = await snapshot(p);
      assert.equal(undone.text, text, 'native Undo restores the exact image source');
      assert(undone.focus, 'native Undo keeps the source input owner');
      trace.push(await state());
      await capture("delete-" + (syntax.startsWith("<") ? "html" : "balanced-url"));
      await p.keyboard.press('Control+y');
      const redone = await snapshot(p);
      assert.equal(redone.text, deleted, 'native Redo repeats only the image deletion');
      assert(redone.focus, 'native Redo keeps the source input owner');
      await p.keyboard.insertText('K');
      assert.equal((await snapshot(p)).text, deleted + 'K', 'immediate trusted input uses the resumed source caret');
      await p.keyboard.press('Control+s');
      await waitUntil(() => fs.readFileSync(doc, 'utf8') === deleted + 'K', 'image command continuation saved as exact source');
      trace.push({ continuation: await state(), diskSha256: sha256(doc) });
      await capture('delete-continue-' + (syntax.startsWith('<') ? 'html' : 'balanced-url'));
    });
    await check("image-address-edit-and-stale-dialog-guard", async (trace) => {
      fs.copyFileSync(fixtureB, path.join(docDir, "assets", "fixture-b.png"));
      const text = "![](assets/fixture-a.png)\n\n\u6B63\u6587";
      await reset(p, text, text.length);
      await decoded();
      await imageMenu("\u7F16\u8F91\u56FE\u7247\u5730\u5740\u2026");
      assert(await p.locator('#mp-image-url').evaluate(i => document.activeElement === i), 'image address dialog retains its native input owner');
      await p.locator("#mp-image-url").fill("assets/fixture-b.png");
      await p.locator("#mp-image-url-go").click();
      await waitUntil(() => p.evaluate(() => document.querySelector(".mp-img img")?.src.endsWith("/fixture-b.png")), "edited image address");
      assert((await snapshot(p)).text.includes("fixture-b.png"));
      await capture("edited-address");
      await imageMenu("\u7F16\u8F91\u56FE\u7247\u5730\u5740\u2026");
      await p.locator("#mp-image-url").fill("WRONG.png");
      const same = (await snapshot(p)).text;
      await p.evaluate((text2) => window.mpEngine.setValue(text2), same);
      await p.locator("#mp-image-url-go").click();
      assert.equal((await snapshot(p)).text, same, "same-text reset invalidates stale address command");
      await reset(p, text, text.length);
      await imageMenu("\u81EA\u5B9A\u4E49\u2026");
      assert(await p.locator('#mp-scale-in').evaluate(i => document.activeElement === i), 'custom image size dialog retains its native input owner');
      await reopen(other);
      assert.equal(await p.locator("#mp-scale-go").count(), 0, "document switch closes image size dialog");
      assert.equal((await snapshot(p)).text, "OTHER DOCUMENT\n");
      trace.push(await state());
      await reopen(doc);
    });
    await check("size-presets-are-distinct-stable-and-reversible", async (trace) => {
      const text = "![](assets/fixture-a.png)\n\n\u6B63\u6587";
      await reset(p, text, text.length);
      await decoded();
      const widths = /* @__PURE__ */ new Map();
      for (const percent of [25, 50, 75, 100, 50, 25, 100]) {
        await imageMenu(percent + "%");
        await decoded();
        const s = await snapshot(p), ui = (await images())[0], stored = Number(/width="(\d+)"/.exec(s.text)?.[1]);
        assert(s.focus, 'image size preset returns keyboard focus to the source owner');
        assert(stored > 0, "menu rewrites exact image width");
        if (widths.has(percent)) assert(Math.abs(widths.get(percent) - ui.width) < 2, "repeat preset is idempotent");
        widths.set(percent, ui.width);
        trace.push({ percent, stored, display: ui.width, state: await state() });
        await capture("size-" + percent + "-" + trace.length);
      }
      assert(widths.get(25) < widths.get(50) && widths.get(50) < widths.get(75) && widths.get(75) < widths.get(100));
    });
    await check("size-presets-respect-editor-zoom", async (trace) => {
      for (const zoom of [150, 100]) {
        await p.evaluate((zoom2) => window.mpEngine.setPref("zoom", zoom2), zoom);
        await sleep(250);
        await imageMenu("50%");
        await decoded();
        const dimensions = await p.evaluate(() => {
          const i = document.querySelector(".mp-img img"), l = i.closest(".cm-line"), s = getComputedStyle(l);
          return { natural: i.naturalWidth, available: l.clientWidth - (parseFloat(s.paddingLeft) || 0) - (parseFloat(s.paddingRight) || 0), stored: Number(i.getAttribute("width")), display: i.getBoundingClientRect().width };
        });
        assert(Math.abs(dimensions.stored - Math.round(Math.min(dimensions.natural, dimensions.available) * 0.5)) <= 1);
        trace.push({ zoom, ...dimensions });
        await capture("zoom-" + zoom);
      }
    });
    await check("image-menu-uses-second-image-identity", async (trace) => {
      const text = "![](assets/fixture-a.png) ![](assets/fixture-a.png)\n\n\u6B63\u6587";
      await reset(p, text, text.length);
      await decoded();
      await imageMenu("25%", p, 1);
      const s = await snapshot(p);
      assert(s.text.startsWith("![](assets/fixture-a.png) <img"), "only second image is rewritten");
      trace.push(await state());
      await capture("second-image");
    });
    for (const [id, syntax, expected] of [
      ["quoted-greater", '<img src="assets/fixture-a.png" alt="a>b" height="80" title="caption">', { alt: "a>b", height: "80", title: "caption" }],
      ["balanced-parentheses", "![x](assets/a(b).png)", { alt: "x" }],
      ["html-entities", '<img src="assets/a&amp;b.png" alt="one &amp; two" height="80">', { alt: "one & two", height: "80" }],
      ["data-src-boundary", '<img data-src="missing.png" src="assets/fixture-a.png">', {}]
    ]) await check("image-attrs-" + id, async (trace) => {
      for (const name of ["a(b).png", "a&b.png"]) fs.copyFileSync(fixtureA, path.join(docDir, "assets", name));
      const text = syntax + "\n\n\u6B63\u6587";
      await reset(p, text, text.length);
      await decoded();
      await imageMenu("\u5C45\u4E2D");
      await decoded();
      const actual = await p.evaluate(() => {
        const i = document.querySelector(".mp-img img");
        return { alt: i.alt, height: i.getAttribute("height"), title: i.title, src: i.src };
      });
      for (const [k, v] of Object.entries(expected)) assert.equal(actual[k], v);
      assert(!actual.src.includes("missing"));
      const plain = await p.evaluate(text => new DOMParser().parseFromString(text, 'text/html').body.textContent.trim(), (await snapshot(p)).text);
      assert.equal(plain, '正文', 'image range rewrite leaves no stray attributes or URL suffix');
      trace.push({ state: await state(), actual });
      const aligned = await snapshot(p);
      assert(aligned.focus, 'image alignment returns keyboard focus to the source owner');
      await p.keyboard.insertText('K');
      assert.equal((await snapshot(p)).text, aligned.text.slice(0, aligned.selection.head) + 'K' + aligned.text.slice(aligned.selection.head), 'alignment permits immediate trusted continuation');
      await p.keyboard.press('Control+z');
      assert.equal((await snapshot(p)).text, aligned.text, 'continuation Undo preserves the image alignment source');
      await capture("attrs-" + id);
    });
    await check("equal-length-middle-url-change-shows-new-pixels", async (trace) => {
      const prefix = "a".repeat(36), suffix = "z".repeat(36) + ".png", names = [prefix + "A" + suffix, prefix + "B" + suffix];
      fs.copyFileSync(fixtureA, path.join(docDir, "assets", names[0]));
      fs.copyFileSync(fixtureB, path.join(docDir, "assets", names[1]));
      let text = "![](assets/" + names[0] + ")\n\n\u6B63\u6587";
      await reset(p, text, text.length);
      await decoded();
      text = text.replace(names[0], names[1]);
      await p.evaluate((text2) => window.mpEngine.setValue(text2), text);
      await waitUntil(() => p.evaluate(() => {
        const i = document.querySelector(".mp-img img");
        return i?.complete && i.src.includes("B" + "z".repeat(36));
      }), "new image source");
      const pixel = await p.evaluate(() => {
        const i = document.querySelector(".mp-img img"), c = document.createElement("canvas");
        c.width = c.height = 1;
        c.getContext("2d").drawImage(i, 0, 0);
        return [...c.getContext("2d").getImageData(0, 0, 1, 1).data];
      });
      assert.deepEqual(pixel, [248, 220, 215, 255]);
      trace.push({ pixel, state: await state(), images: await images() });
      await capture("middle-url-change");
    });
    await check("relative-file-data-copy-and-save-use-real-bytes", async (trace) => {
      const data = "data:image/png;base64," + fs.readFileSync(fixtureA).toString("base64");
      for (const src of ["assets/fixture-a.png", pathToFileURL(assetA).href, data]) {
        const copied = await p.evaluate((src2) => window.mpHost.writeImage(src2), src);
        assert(copied.ok);
        assert(verifyBitmap(fixtureA).matches, "copied bitmap pixels");
        const saved = await p.evaluate((src2) => window.mpHost.saveImageAs({ src: src2, fileName: "screenshot.png" }), src);
        assert(saved.ok);
        assert.equal(sha256(saveImage), sha256(fixtureA), "save preserves original PNG bytes");
        trace.push({ kind: src.startsWith("data:") ? "data" : src.startsWith("file:") ? "file" : "relative", copied, saved });
      }
      await setClipboard(fixtureA);
    });
    await check("two-windows-use-their-own-image-directory", async (trace) => {
      const secondDir = path.join(dir, "second \u4E2D\u6587 #folder%"), second = path.join(secondDir, "second.md");
      fs.mkdirSync(path.join(secondDir, "assets"), { recursive: true });
      fs.copyFileSync(fixtureB, path.join(secondDir, "assets", "fixture-a.png"));
      fs.writeFileSync(second, "![](assets/fixture-a.png)\n\nSECOND");
      const q = await newWindow(run, p, second);
      await q.bringToFront();
      await decoded(q);
      const copied = await q.evaluate(() => window.mpHost.writeImage("assets/fixture-a.png"));
      assert(copied.ok);
      assert(verifyBitmap(fixtureB).matches);
      await capture("secondary-image", q);
      const saved = await q.evaluate(() => window.mpHost.saveImageAs({ src: "assets/fixture-a.png" }));
      assert(saved.ok);
      assert.equal(sha256(saveImage), sha256(fixtureB));
      const primary = await p.evaluate(() => window.mpHost.writeImage("assets/fixture-a.png"));
      assert(primary.ok);
      assert(verifyBitmap(fixtureA).matches);
      trace.push({ copied, saved, primary });
      await p.bringToFront();
      await setClipboard(fixtureA);
    });
    await check("window-boot-and-new-document-preserve-session-identity", async (trace) => {
      const primary = await p.evaluate(() => window.mpHost.docInfo());
      const beforeText = (await snapshot(p)).text;
      const q = await newWindow(run, p, null);
      await q.bringToFront();
      const initial = await q.evaluate(() => window.mpHost.docInfo());
      assert(initial.documentId && initial.filePath === null);
      const ready = await q.evaluate(() => window.mpHost.docReady());
      assert.equal(ready.documentId, initial.documentId, "read-only blank boot keeps its existing identity");
      assert.equal((await q.evaluate(() => window.mpHost.docInfo())).documentId, initial.documentId);
      trace.push({ beforeNew: await state(q), initial, ready });
      const menu = await q.evaluate(() => window.mpHost.recentTestMenuClick("menu-new-document"));
      assert(menu.ok, "invoke the real new-document menu handler for the owning window");
      trace.push({ menu });
      try {
        await waitUntil(() => q.evaluate(id => window.mpHost.docInfo().then(d => d.documentId !== id && d.filePath === null), initial.documentId), "explicit new document resets its own identity");
      } catch (e) {
        trace.push({ failedNew: await state(q), docInfo: await q.evaluate(() => window.mpHost.docInfo()) });
        await capture("failed-blank-window-new-document", q); throw e;
      }
      const current = await q.evaluate(() => window.mpHost.docInfo());
      for (const metadata of [{ documentId: initial.documentId }, {}, { documentId: initial.documentId, explicit: true }]) {
        const denied = await q.evaluate(metadata => window.mpHost.docPath(null, metadata), metadata);
        assert.equal(denied.code, "MP_DOC_MISMATCH", "stale or missing identity cannot clear a newer document");
        assert.equal((await q.evaluate(() => window.mpHost.docInfo())).documentId, current.documentId);
      }
      assert((await snapshot(q)).focus);
      await q.keyboard.type("new window input", { delay: 25 });
      assert.equal((await snapshot(q)).text, "new window input");
      await capture("blank-window-native-input", q);
      trace.push({ initial, current, staleRequestsDenied: 3, nativeInput: true });
      await q.evaluate(() => window.mpHost.docDirty(false));
      await q.close(); await p.bringToFront();
      assert.equal((await p.evaluate(() => window.mpHost.docInfo())).documentId, primary.documentId);
      assert.equal((await snapshot(p)).text, beforeText, "secondary new document does not change the primary");
    });
    await check("concurrent-equal-size-images-never-overwrite-assets", async (trace) => {
      const a = fs.readFileSync(fixtureA), b = fs.readFileSync(fixtureB), length = Math.max(a.length, b.length), aa = Buffer.concat([a, Buffer.alloc(length - a.length)]), bb = Buffer.concat([b, Buffer.alloc(length - b.length)]);
      const receipts = await p.evaluate(async ({ docPath, a: a2, b: b2 }) => Promise.all([window.mpHost.saveImageToAssets({ docPath, base64: a2, mime: "image/png", fileName: "same #%().png" }), window.mpHost.saveImageToAssets({ docPath, base64: b2, mime: "image/png", fileName: "same #%().png" })]), { docPath: doc, a: aa.toString("base64"), b: bb.toString("base64") });
      assert(receipts.every((r) => r.ok));
      assert.notEqual(receipts[0].relPath, receipts[1].relPath);
      assert.deepEqual(fs.readFileSync(receipts[0].absPath), aa);
      assert.deepEqual(fs.readFileSync(receipts[1].absPath), bb);
      trace.push(receipts);
    });
    await check('asset-created-during-save-is-never-overwritten', async trace => {
      const folder = path.join(dir, 'external-asset-race'), file = path.join(folder, 'race.md'), assets = path.join(folder, 'assets');
      fs.mkdirSync(assets, {recursive: true}); fs.writeFileSync(file, 'Race fixture\n');
      const a = Buffer.concat([fs.readFileSync(fixtureA), Buffer.alloc(24 * 1024 * 1024)]), b = fs.readFileSync(fixtureB);
      const target = path.join(assets, 'raced.png'); let observedTemp = false, externalCreated = false, externalError;
      const watcher = fs.watch(assets, (_event, name) => {
        if (!String(name).startsWith('raced.png.mp-tmp-') || externalCreated || externalError) return;
        observedTemp = true;
        try { fs.writeFileSync(target, b, {flag: 'wx'}); externalCreated = true; }
        catch (e) { externalError = e.message; }
      });
      let saved;
      try {
        saved = await p.evaluate(({docPath, base64}) => window.mpHost.saveImageToAssets({docPath, base64, mime: 'image/png', fileName: 'raced.png'}), {docPath: file, base64: a.toString('base64')});
      } finally { watcher.close(); }
      trace.push({observedTemp, externalCreated, externalError, saved, externalSha256: fs.existsSync(target) ? sha256(target) : null});
      assert(observedTemp && externalCreated && !externalError, 'External producer must win after temporary creation and before final commit');
      assert(saved.ok); assert.notEqual(saved.absPath, target, 'Late external asset is never overwritten');
      assert.deepEqual(fs.readFileSync(target), b); assert.deepEqual(fs.readFileSync(saved.absPath), a);
      assert(!fs.readdirSync(assets).some(n => n.includes('.mp-tmp-')), 'Temporary asset is cleaned');
    });
    await check("failed-assets-write-keeps-inline-image", async (trace) => {
      const blockedDir = path.join(dir, "blocked"), blocked = path.join(blockedDir, "blocked.md");
      fs.mkdirSync(blockedDir);
      fs.writeFileSync(blocked, "\u6B63\u6587\n");
      fs.writeFileSync(path.join(blockedDir, "assets"), "not a directory");
      await reopen(blocked);
      await reset(p, "\u6B63\u6587\n", 3);
      await paste();
      await decoded();
      assert((await snapshot(p)).text.includes("data:image/png;base64,"));
      const toast = await p.evaluate(() => document.querySelector(".mp-toast")?.textContent);
      assert(toast.includes("\u5DF2\u6539\u4E3A\u5185\u8054"));
      trace.push({ state: await state(), toast });
      await capture("failed-write-inline");
      await reopen(doc);
    });
    await check("unsaved-screenshot-renders-without-path", async (trace) => {
      await p.evaluate(() => window.mpHost.docDirty(false));
      const blank = await newBlankWindow(run, p);
      await reset(blank, "\u672A\u547D\u540D\n", 4);
      await paste(fixtureA, blank);
      await decoded(blank);
      const s = await snapshot(blank);
      assert(s.text.includes("data:image/png;base64,"));
      assert(!s.text.includes("assets/"));
      trace.push({ state: await state(blank), images: await images(blank) });
      await capture("unsaved-inline", blank);
      await blank.evaluate(() => window.mpHost.docDirty(false));
      await blank.close();
      await p.bringToFront();
      await reopen(doc);
    });
    await check("mouse-combination-drag-copy-preserve-image-markdown", async (trace) => {
      const text = "BEFORE words\n\n![](assets/fixture-a.png)\n\nAFTER words";
      await reset(p, text, text.length);
      await decoded();
      await p.locator(".mp-img img").click();
      await decoded();
      assert((await images()).length === 1, "click keeps image rendered");
      // A new native reading intent brings the preceding word into view before
      // deriving coordinates; the image-opening anchor is no longer this intent.
      const scrollBox = await p.locator('.cm-scroller').boundingBox();
      await p.mouse.move(scrollBox.x+40, scrollBox.y+90); await p.mouse.wheel(0,-1000);
      await sleep(120);
      const coords = await p.evaluate(() => {
        const v = window.mpEngine._view(), a = v.coordsAtPos(0), b = v.coordsAtPos(v.state.doc.length);
        const x=a.left+24,y=(a.top+a.bottom)/2,t=document.elementFromPoint(x,y);
        if (!t || !v.contentDOM.contains(t) || !t.closest('.cm-line')?.textContent.startsWith('BEFORE words')) throw Error('Double-click must hit visible BEFORE text');
        return { a, b };
      });
      await p.mouse.click(coords.a.left + 24, (coords.a.top + coords.a.bottom) / 2, { clickCount: 2, delay: 80 });
      assert((await snapshot(p)).selection.anchor !== (await snapshot(p)).selection.head, "native double click selects text");
      await capture("double-click");
      await p.mouse.click(coords.a.left, (coords.a.top + coords.a.bottom) / 2);
      const freshEnd = await p.evaluate(() => window.mpEngine._view().coordsAtPos(window.mpEngine._view().state.doc.length));
      await p.keyboard.down("Shift");
      await p.mouse.click(freshEnd.left, (freshEnd.top + freshEnd.bottom) / 2);
      await p.keyboard.up("Shift");
      await p.keyboard.press("Shift+ArrowLeft");
      let s = await snapshot(p);
      assert(s.text.slice(Math.min(s.selection.anchor, s.selection.head), Math.max(s.selection.anchor, s.selection.head)).includes("![]("));
      await capture("shift-click");
      await reset(p, text, text.length);
      const ends = await p.evaluate(() => {
        const v = window.mpEngine._view();
        return { a: v.coordsAtPos(0), b: v.coordsAtPos(v.state.doc.length) };
      });
      const x = ends.a.left, y = (ends.a.top + ends.a.bottom) / 2, xx = ends.b.left, yy = (ends.b.top + ends.b.bottom) / 2;
      await p.mouse.move(x, y);
      await p.mouse.down();
      for (let n = 1; n <= 8; n++) {
        await p.mouse.move(x + (xx - x) * n / 8, y + (yy - y) * n / 8);
        await sleep(35);
      }
      await p.mouse.up();
      s = await snapshot(p);
      assert.equal(s.text, text);
      const selected = s.text.slice(Math.min(s.selection.anchor, s.selection.head), Math.max(s.selection.anchor, s.selection.head));
      assert(selected.includes("![]("));
      await p.keyboard.press("Control+c");
      assert(verifyText(selected).matches, "mixed selection copies Markdown source");
      trace.push({ state: await state(), selected });
      await capture("drag-copy");
      await setClipboard(fixtureA);
    });
    await check("readonly-directory-keeps-inline-image", async (trace) => {
      const folder = path.join(dir, "readonly \u4E2D\u6587"), file = path.join(folder, "readonly.md");
      fs.mkdirSync(folder);
      fs.writeFileSync(file, "\u6B63\u6587\n");
      await reopen(file);
      await reset(p, "\u6B63\u6587\n", 3);
      const acl = (mode) => JSON.parse(execFileSync(process.env.MP_PWSH || "pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", path.join(__dirname, "image-directory-access.ps1"), "-RunDirectory", dir, "-Directory", folder, "-Mode", mode], { windowsHide: true, encoding: "utf8", timeout: 15e3 }));
      try {
        trace.push(acl("block"));
        assert.throws(() => fs.writeFileSync(path.join(folder, "must-fail.tmp"), "blocked"));
        await paste();
        await decoded();
        assert((await snapshot(p)).text.includes("data:image/png;base64,"));
        const toast = await p.evaluate(() => document.querySelector(".mp-toast")?.textContent);
        assert(toast.includes("\u5DF2\u6539\u4E3A\u5185\u8054"));
        trace.push({ state: await state(), toast });
        await capture("readonly-inline");
      } finally {
        trace.push(acl("restore"));
      }
      fs.writeFileSync(path.join(folder, "restored.tmp"), "writable again");
      await reopen(doc);
    });
    await check("jpeg-webp-copy-save-preserve-format-bytes", async (trace) => {
      for (const mime of ["image/jpeg", "image/webp"]) {
        const data = await p.evaluate(async ({ src: src2, mime: mime2 }) => {
          const i = new Image();
          i.src = src2;
          await i.decode();
          const c = document.createElement("canvas");
          c.width = i.naturalWidth;
          c.height = i.naturalHeight;
          c.getContext("2d").drawImage(i, 0, 0);
          const encoded = c.toDataURL(mime2);
          const decoded2 = new Image();
          decoded2.src = encoded;
          await decoded2.decode();
          c.getContext("2d").drawImage(decoded2, 0, 0);
          return { encoded, expected: c.toDataURL("image/png").split(",")[1] };
        }, { src: pathToFileURL(fixtureA).href, mime });
        assert(data.encoded.startsWith("data:" + mime + ";base64,"));
        const file = path.join(docDir, "assets", "\u4E2D\u6587 #%()." + mime.split("/")[1]), expected = path.join(dir, mime.split("/")[1] + "-decoded.png");
        fs.writeFileSync(file, Buffer.from(data.encoded.split(",")[1], "base64"));
        fs.writeFileSync(expected, Buffer.from(data.expected, "base64"));
        const src = pathToFileURL(file).href, copied = await p.evaluate((src2) => window.mpHost.writeImage(src2), src);
        assert(copied.ok);
        const pixels = verifyBitmap(expected, { meanTolerance: mime === "image/jpeg" ? 2 : 0 });
        trace.push({ mime, pixels });
        assert(pixels.matches, "copied decoded format pixels");
        const saved = await p.evaluate((src2) => window.mpHost.saveImageAs({ src: src2 }), src);
        assert(saved.ok);
        assert.equal(sha256(saveImage), sha256(file));
        trace.push({ mime, copied, saved, sha256: sha256(file) });
      }
      await setClipboard(fixtureA);
    });
    await check('http-image-copy-save-use-original-bytes', async trace => {
      const previousSrc = pathToFileURL(path.join(docDir, 'assets', 'fixture-a.png')).href;
      await reset(p, '![](assets/fixture-a.png)\n\nprevious preview', 0);
      await waitUntil(() => p.evaluate(src => {const expected=new URL(src);return [...document.querySelectorAll('.cm-content .mp-img img')].some(i => {const actual=new URL(i.src);return actual.protocol===expected.protocol && actual.host===expected.host && decodeURIComponent(actual.pathname)===decodeURIComponent(expected.pathname) && i.complete && i.naturalWidth===1369 && i.naturalHeight===857 && !i.classList.contains('mp-img-pending') && !i.closest('.is-failed');});}, previousSrc), 'the prior local preview decoded at its exact source URL', 10000);
      trace.push({ priorPreview: await images() });
      const http = require('node:http'), requests = [], bytes = fs.readFileSync(fixtureA);
      const server = http.createServer((req, res) => { requests.push({url: req.url, referer: req.headers.referer ?? null}); res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': bytes.length}); res.end(bytes); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      try {
        const src = 'http://127.0.0.1:' + server.address().port + '/screenshot.png?literal=%23%25%28%29';
        const copied = await p.evaluate(src => window.mpHost.writeImage(src), src); assert(copied.ok);
        assert(verifyBitmap(fixtureA).matches, 'HTTP image clipboard pixels');
        const saved = await p.evaluate(src => window.mpHost.saveImageAs({src}), src); assert(saved.ok);
        assert.equal(sha256(saveImage), sha256(fixtureA));
        await reset(p, '![](' + src + ')\n\nremote fixture', 0);
        await waitUntil(() => p.evaluate(src => [...document.querySelectorAll('.cm-content .mp-img img')].some(i => {const r=i.getBoundingClientRect();return i.getAttribute('src') === src && i.complete && i.naturalWidth === 1369 && i.naturalHeight === 857 && !i.classList.contains('mp-img-pending') && !i.closest('.is-failed') && r.width>0 && r.height>0;}), src), 'this HTTP fixture decoded at its exact source URL', 10000);
        assert.equal(await p.locator('.cm-content .mp-img img').count(), 1, 'completed replacement retires the previous preview');
        assert(requests.length >= 2); assert(requests.every(r => r.referer === null), 'No local document Referer sent');
        trace.push({copied, saved, requests}); await capture('http-image');
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await setClipboard(fixtureA); }
    });
    await check('predecode-faults-do-not-swallow-real-screenshot', async trace => {
      for (const mode of ['reject', 'timeout']) {
        const text = 'Predecode ' + mode + '\n'; await reset(p, text, text.length);
        await p.evaluate(mode => {
          window.__savedImageDecode = HTMLImageElement.prototype.decode;
          window.__decodeFaultCalls = 0;
          HTMLImageElement.prototype.decode = function() { window.__decodeFaultCalls++; return mode === 'reject' ? Promise.reject(new Error('owned decode failure')) : new Promise(() => {}); };
        }, mode);
        const start = performance.now();
        try {
          await paste();
          await waitUntil(() => p.evaluate(() => [...document.querySelectorAll('.mp-img img')].some(i => i.complete && i.naturalWidth === 1369 && !i.closest('.is-failed'))), 'real screenshot survives predecode ' + mode, 22000);
          const s = await snapshot(p), elapsed = Math.round(performance.now() - start), calls = await p.evaluate(() => window.__decodeFaultCalls);
          assert.equal(calls, 1, 'Only the temporary insertion probe decodes');
          assert(s.text.startsWith(text)); assert.equal((s.text.match(/!\[\]\(assets\//g) || []).length, 1, 'One actual image commit');
          const rel = /!\[\]\((assets\/[^)]+)\)/.exec(s.text)?.[1]; assert(rel && fs.existsSync(path.join(docDir, decodeURIComponent(rel))));
          if (mode === 'timeout') assert(elapsed >= imageDelayMs + 9500 && elapsed < imageDelayMs + 15000, 'Decode has a real bounded ten-second wait');
          trace.push({mode, elapsed, imageHostDelayMs: imageDelayMs, calls, state: await state(), images: await images()}); await capture('predecode-' + mode);
        } finally { await p.evaluate(() => { HTMLImageElement.prototype.decode = window.__savedImageDecode; delete window.__savedImageDecode; }); }
      }
    });
    await check('custom-image-scale-has-useful-small-and-large-limits', async trace => {
      const small = path.join(docDir, 'assets', 'small.png');
      fs.writeFileSync(small, Buffer.from(await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 100; c.height = 60; const x = c.getContext('2d'); x.fillStyle = '#1769a5'; x.fillRect(0, 0, 100, 60); return c.toDataURL('image/png').split(',')[1]; }), 'base64'));
      for (const [source, width] of [['assets/small.png', 100], ['assets/fixture-a.png', 1369]]) {
        const text = '![](' + source + ')\n\ncustom scale fixture'; await reset(p, text, text.length);
        await waitUntil(() => p.evaluate(width => document.querySelector('.mp-img img')?.naturalWidth === width, width), 'custom scale fixture decode');
        const sizes = [];
        for (const percent of [5, 100, 400, 100]) {
          await imageMenu('自定义…'); const input = p.locator('#mp-scale-in'); await input.click(); await input.press('Control+a'); await input.type(String(percent), {delay: 30}); await input.press('Enter');
          await waitUntil(() => p.evaluate(() => !document.querySelector('#mp-scale-in')), 'custom scale dialog applied');
          await sleep(120);
          const dims = await p.evaluate(() => { const i = document.querySelector('.mp-img img'), line = i.closest('.cm-line'), s = getComputedStyle(line); return {stored: Number(i.getAttribute('width')), display: i.getBoundingClientRect().width, natural: i.naturalWidth, available: line.clientWidth - (parseFloat(s.paddingLeft) || 0) - (parseFloat(s.paddingRight) || 0)}; });
          assert.equal(dims.stored, Math.max(1, Math.round(Math.min(dims.natural, dims.available) * percent / 100)));
          assert(dims.display <= dims.available + 1); sizes.push({percent, ...dims});
        }
        assert.equal(sizes[1].stored, sizes[3].stored); assert.equal(sizes[1].display, sizes[3].display);
        if (width === 100) assert(sizes[2].display > sizes[1].display * 3.9, '400% enlarges a small image');
        else assert(Math.abs(sizes[2].display - sizes[1].display) < 1, 'Large image enlargement stays within text width');
        trace.push({source, sizes}); await capture('custom-scale-' + width);
      }
    });
    await check("size-presets-follow-current-page-width", async (trace) => {
      const text = "![](assets/fixture-a.png)\n\n\u6B63\u6587";
      await reset(p, text, text.length);
      await decoded();
      for (const pageWidth of [55, 90, 55]) {
        await p.evaluate((width) => window.mpEngine.setPref("pageWidth", width), pageWidth);
        await sleep(200);
        await imageMenu("50%");
        const dims = await p.evaluate(() => {
          const i = document.querySelector(".mp-img img"), l = i.closest(".cm-line");
          return { natural: i.naturalWidth, available: l.clientWidth, stored: Number(i.getAttribute("width")), display: i.getBoundingClientRect().width };
        });
        assert(Math.abs(dims.stored - Math.round(Math.min(dims.natural, dims.available) * 0.5)) <= 1);
        trace.push({ pageWidth, ...dims });
        await capture("page-width-" + pageWidth + "-" + trace.length);
      }
      assert.equal(trace[0].stored, trace[2].stored);
      assert(trace[1].stored > trace[0].stored);
      await p.evaluate(() => window.mpEngine.setPref("pageWidth", 74));
    });
    await check("high-image-next-to-table-keeps-image-menu", async (trace) => {
      for (const order of ["before", "after"]) {
        const image = "![](assets/fixture-a.png)", table = "| a | b |\n| --- | --- |\n| 1 | 2 |", text = (order === "before" ? image + "\n\n" + table : table + "\n\n" + image) + "\n\n\u6B63\u6587";
        await reset(p, text, text.length);
        await decoded();
        await imageMenu("25%");
        assert((await snapshot(p)).text.includes('<img src="assets/fixture-a.png"'));
        assert((await snapshot(p)).text.includes(table));
        trace.push({ order, state: await state() });
        await capture("adjacent-table-" + order);
      }
    });
    await check("document-switch-same-relative-name-updates-pixels", async (trace) => {
      const text='![](assets/fixture-a.png)\n\n正文',folder=path.join(dir,'same relative name'),file=path.join(folder,'switch.md');
      fs.mkdirSync(path.join(folder,'assets'),{recursive:true});fs.copyFileSync(fixtureB,path.join(folder,'assets','fixture-a.png'));fs.writeFileSync(file,text);
      await reopen(doc);await reset(p,text,text.length);await decoded();await reopen(file);await p.evaluate(()=>{const v=window.mpEngine._view();v.dispatch({selection:{anchor:v.state.doc.length},scrollIntoView:true});v.focus();});await decoded();
      const pixel=await p.evaluate(()=>{const i=document.querySelector('.mp-img img'),c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.drawImage(i,0,0);return [...x.getImageData(0,0,1,1).data];});assert.deepEqual(pixel,[248,220,215,255]);trace.push({pixel,images:await images()});await capture('directory-change-same-source');await reopen(doc);
    });
    await check("extract-inline-image-cancels-on-concurrent-edit", async (trace) => {
      const text = "![](data:image/png;base64," + fs.readFileSync(fixtureA).toString("base64") + ")\n\n\u6B63\u6587";
      await reset(p, text, text.length);
      await decoded();
      await imageMenu("\u62BD\u51FA\u5230 assets");
      await p.evaluate(() => window.mpEngine.focus());
      assert((await snapshot(p)).focus);
      await p.keyboard.insertText("TYPED");
      await sleep(5500);
      assert((await snapshot(p)).text === text + "TYPED", "conversion preserves concurrent user edit and inline image");
      trace.push({ state: await state(), toast: await p.evaluate(() => document.querySelector(".mp-toast")?.textContent) });
      await capture("extract-canceled");
    });
  } catch (e) {
    result.fatal = e.stack;
  } finally {
    if (clip) {
      try {
        result.clipboardCleanup = await clip.restore();
      } catch (e) {
        result.clipboardCleanup = { restored: false, error: e.message };
      }
    }
    result.cleanup = run ? await run.cleanup() : { residual: [] };
    release();
    result.completedAt = (/* @__PURE__ */ new Date()).toISOString();
    result.passed = !result.fatal && result.cases.length > 0 && result.cases.every((c) => c.status === "pass") && result.cleanup.residual.length === 0 && result.clipboardCleanup?.restored === true;
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, total: result.cases.length, failed: result.cases.filter((c) => c.status === "fail").map((c) => c.id), cleanup: result.cleanup, clipboard: result.clipboardCleanup }));
  }
  process.exitCode = result.passed ? 0 : 1;
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
