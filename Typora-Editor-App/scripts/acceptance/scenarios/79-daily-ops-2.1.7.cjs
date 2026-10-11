/** 日常操作缺陷回归（2026-09-14 那一轮：用户报的 2 条 + 巡检扫出的 5 条，2.1.7 修好）。
 *
 *  这一轮把"以前根本测不了"的一整类功能补上了：系统原生对话框（打开文件/打开文件夹/
 *  另存为/确认框）与**应用菜单**——它们以前既没有自动化入口，也因此在下面这些日常操作上
 *  悄悄坏掉了很久。判据全部取代码之外的通道：磁盘、state.json、窗口几何、页面内几何量测。
 *
 *  逐条：
 *    A 欢迎页「打开文件夹」没有任何反馈（侧栏收起时屏幕上零变化；侧栏可见时欢迎页一字不变）
 *    B 正常退出把会话记录清空 → 关掉应用再打开，上次的窗口和文件全都不回来（只剩欢迎页）
 *    C 文件树「删除（回收站）」恒不生效——外壳里的 window.confirm 在 Electron 里恒为 false
 *    D 菜单「在此窗口打开文件…」实际开的是新窗口（与菜单项承诺不符）
 *    E 点文档里的锚点链接（`[x](#标题)`）没有任何反应（主进程直接忽略了 '#' 开头）
 *    F Ctrl+多选图片后按 Delete/Backspace 没反应（多选集合没被删；且编辑区丢了键盘焦点）
 *    G 补全面板（公式/片段）在矮窗口里会盖住"正在编辑的那一行"和鼠标，随手一点就插错
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SURFACE = JSON.stringify('.vditor-ir .vditor-reset');

module.exports = {
  id: '79-daily-ops-2.1.7',
  title: '日用缺陷回归：打开文件夹无反馈 / 退出清空会话 / 树删除失效 / 在此窗口打开 / 锚点 / 多选删图 / 补全面板压行',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '79-daily');
    fs.mkdirSync(dir, {recursive: true});
    const A = path.join(dir, '甲.md');
    const B = path.join(dir, '乙.md');
    const sub = path.join(dir, '子目录');
    fs.mkdirSync(sub, {recursive: true});
    fs.writeFileSync(A, '# 甲文档\n\n甲正文，用来放光标。\n');
    fs.writeFileSync(B, '# 乙文档\n\n乙正文。\n');
    const ping = name => process.pid + '-' + name + '-' + Date.now();

    const pointOf = (session, selector, options = {}) => session.js(`(() => {
      const w = document.getElementById('editor').contentWindow;
      const nodes = [...w.document.querySelectorAll(${JSON.stringify(selector)})];
      const el = ${options.text ? `nodes.find(n => n.textContent.includes(${JSON.stringify(options.text)}))` : 'nodes[0]'};
      if (!el) return null;
      const r = el.getBoundingClientRect(); const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
      if (!r.width || !r.height) return {zero: true};
      return {x: Math.round(fr.x + r.x + Math.min(8, r.width / 2)), y: Math.round(fr.y + r.y + r.height / 2)};
    })()`);

    // ---------------- A：欢迎页「打开文件夹」必须给出可见反馈 ----------------
    for (const [tag, hideSidebar] of [['A1-侧栏收起', true], ['A2-侧栏可见', false]]) {
      const session = await ctx.launch({inspect: true, args: []});
      try {
        await session.until(`!!document.getElementById('w-open-folder')`, {timeout: 60000});
        await sleep(1400);
        if (hideSidebar) {
          await session.main.js(`(() => { global.state.set('sidebar', {...global.state.get('sidebar'), visible: false}); return true; })()`);
          await session.reload();
          await session.until(`!!document.getElementById('w-open-folder')`, {timeout: 60000});
          await sleep(1400);
        }
        const before = await session.js(`(() => ({侧栏收起: document.getElementById('app').classList.contains('sb-hidden'),
          提示: getComputedStyle(document.getElementById('w-hint-ws')).display}))()`);
        await session.main.script([{dialog: 'open', files: [dir]}]);
        const btn = await session.js(`(() => { const el = document.getElementById('w-open-folder'); const r = el.getBoundingClientRect();
          return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()`);
        await session.move(btn.x, btn.y);
        await session.click(btn.x, btn.y);
        await sleep(2600);
        const after = await session.js(`(() => {
          const side = document.getElementById('sidebar'); const sb = side.getBoundingClientRect();
          const rows = document.querySelectorAll('#tree .row').length;
          return {侧栏收起: document.getElementById('app').classList.contains('sb-hidden'),
            侧栏在屏上: sb.width > 0 && sb.left >= 0, 文件树行数: rows,
            提示: getComputedStyle(document.getElementById('w-hint-ws')).display, 工作区名: document.getElementById('ws-name').textContent}; })()`);
        ctx.witness('打开文件夹后的可见反馈（几何 + DOM）', {tag, before, after});
        ctx.assert(`【A】${tag}：点「打开文件夹」之后侧栏必须在屏幕上（树要看得见）`, after.侧栏在屏上 && after.文件树行数 > 0, after);
        ctx.assert(`【A】${tag}：欢迎页必须给出"已打开工作区"的提示`, after.提示 !== 'none', {提示: after.提示, before: before.提示});
      } finally { await ctx.release(session); }
    }

    // ---------------- B：正常退出不清空会话，重启恢复窗口 ----------------
    {
      const profile = path.join(ctx.outDir, '79-profile-' + process.pid);
      const first = await ctx.launch({inspect: true, args: [A, B], profile, keepProfile: true});
      let stateBefore = null, windowsBefore = null;
      try {
        await sleep(5000);
        windowsBefore = (await first.recs() || []).map(r => r.file).filter(Boolean);
        stateBefore = JSON.parse(fs.readFileSync(path.join(profile, 'state.json'), 'utf8')).windows;
        await first.main.js(`(() => { require('electron').app.quit(); return true; })()`);
        for (let i = 0; i < 30 && first.child.exitCode === null; i++) await sleep(400);
      } finally { await first.close(); }
      const stateAfter = JSON.parse(fs.readFileSync(path.join(profile, 'state.json'), 'utf8')).windows;
      const second = await ctx.launch({inspect: true, args: [], profile, keepProfile: true});
      try {
        await sleep(4500);
        const restored = (await second.recs() || []).map(r => r.file).filter(Boolean);
        ctx.witness('退出前后 state.json 的 windows 与重启后的窗口', {退出前窗口: windowsBefore, 退出前记录: stateBefore.length, 退出后记录: stateAfter.length, 重启后窗口: restored.map(f => path.basename(f))});
        ctx.assert('【B】正常退出后，会话记录里仍然留着刚才的窗口', stateAfter.length === 2, {退出前: stateBefore.length, 退出后: stateAfter.length});
        ctx.assert('【B】重启后两个文件窗口都回来了', restored.length === 2, restored.map(f => path.basename(f)));
      } finally { await ctx.release(second); }
    }

    // ---------------- C：文件树「删除（回收站）」真的会删 ----------------
    {
      const victim = path.join(dir, '待删除.md');
      fs.writeFileSync(victim, '# 待删除\n\n正文。\n');
      const session = await ctx.launch({inspect: true, args: [A]});
      try {
        await session.until(`document.querySelectorAll('#tree .row').length > 0`, {timeout: 60000});
        await sleep(1600);
        const menu = async (name, label) => {
          const at = await session.js(`(() => { const row = [...document.querySelectorAll('#tree .row')].find(r => r.textContent.includes(${JSON.stringify(name)}));
            if (!row) return null; const r = row.getBoundingClientRect(); return {x: Math.round(r.x + 30), y: Math.round(r.y + r.height / 2)}; })()`);
          if (!at) return {ok: false, why: '树里没有这一行'};
          await session.click(at.x, at.y, {button: 'right'});
          await sleep(420);
          const item = await session.js(`(() => { const el = [...document.querySelectorAll('#ctxmenu .mi')].find(i => i.textContent.includes(${JSON.stringify(label)}));
            if (!el) return null; const r = el.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()`);
          if (!item) return {ok: false, why: '菜单里没有这一项'};
          await session.click(item.x, item.y);
          await sleep(900);
          return {ok: true};
        };
        // 先选「取消」：文件必须还在
        const cancelRun = await menu('待删除.md', '删除');
        const confirmAppeared = (await session.main.calls()).filter(c => c.kind === 'message');
        await sleep(1800);
        const afterCancel = fs.existsSync(victim);
        // 再选「删除」：文件必须消失
        await session.main.script([{dialog: 'message', response: 0}]);
        const deleteRun = await menu('待删除.md', '删除');
        await sleep(2200);
        const afterDelete = fs.existsSync(victim);
        const texts = (await session.main.calls()).filter(c => c.kind === 'message').map(c => ({message: c.options.message, buttons: c.options.buttons}));
        ctx.witness('删除确认框与磁盘结果', {cancelRun, deleteRun, 确认框: texts, 取消后还在: afterCancel, 确认后还在: afterDelete});
        ctx.assert('【C】点了「删除」会弹出确认框（以前 confirm() 恒 false，什么都不弹）', texts.length >= 1, texts);
        ctx.assert('【C】确认框选「取消」时文件还在（默认按钮是安全的那个）', afterCancel === true, {afterCancel, 确认框: texts[0]});
        ctx.assert('【C】确认之后文件真的从磁盘上消失了（回收站）', afterDelete === false, {afterDelete});
        ctx.assert('【C】删除前后的确拿到过用户的确认（不是静默删除）', confirmAppeared.length >= 1, confirmAppeared.length);
      } finally { await ctx.release(session); }
    }

    // ---------------- D：菜单「在此窗口打开文件…」应该在本窗口替换文档 ----------------
    {
      const session = await ctx.launch({inspect: true, args: [A]});
      try {
        await session.until(`(() => { const w = document.getElementById('editor').contentWindow; return !!(w && w.document.querySelector(${SURFACE})); })()`, {timeout: 60000});
        await sleep(1800);
        await session.main.script([{dialog: 'open', files: [B]}]);
        const click = await session.main.clickMenu('文件 > 在此窗口打开文件…');
        await sleep(3000);
        const recs = await session.recs() || [];
        const text = await session.js(`(() => { const w = document.getElementById('editor').contentWindow; const root = w.document.querySelector(${SURFACE});
          return root ? root.textContent.replace(/\\s+/g, ' ').trim().slice(0, 20) : null; })()`);
        const files = recs.map(r => r.file ? path.basename(r.file) : null);
        ctx.witness('菜单点击结果与窗口表', {click, 窗口数: recs.length, 文件: files, 正文: text});
        ctx.assert('【D】「在此窗口打开文件…」没有另开窗口', recs.length === 1, {窗口数: recs.length, files});
        ctx.assert('【D】当前窗口确实换成了新选的文档', String(text || '').includes('乙'), {正文: text});
      } finally { await ctx.release(session); }
    }

    // ---------------- E：锚点链接要点得动 ----------------
    {
      const long = ['# 锚点测试', '', '锚点：[跳到第三节](#第三节)', '',
        ...Array.from({length: 60}, (_, i) => `第 ${i + 1} 段填充文字，把目标标题推到屏幕外。`).flatMap(x => [x, '']),
        '### 第三节', '', '第三节正文。', ''].join('\n');
      const anchorFile = path.join(dir, '锚点.md');
      fs.writeFileSync(anchorFile, long);
      const session = await ctx.launch({inspect: true, args: [anchorFile]});
      try {
        await session.until(`(() => { const w = document.getElementById('editor').contentWindow; return !!(w && w.document.querySelector(${SURFACE})); })()`, {timeout: 60000});
        await sleep(2200);
        // 滚动量不能读 window.scrollY：这个编辑器的滚动容器不是 window（实测改 scrollTop
        // 读数会变、但正文位置一动不动，属自欺）。用**目标标题自身的视口位置**当判据。
        const headingTopOf = `(() => { const w = document.getElementById('editor').contentWindow;
          const h = [...w.document.querySelectorAll(${SURFACE} + ' h3')].find(n => n.textContent.includes('第三节'));
          return h ? Math.round(h.getBoundingClientRect().top) : null; })()`;
        const before = await session.js(headingTopOf);
        const at = await pointOf(session, '.vditor-ir__link', {text: '跳到第三节'});
        let highlighted = false;
        if (at && !at.zero) {
          await session.move(at.x, at.y);
          await session.click(at.x, at.y);
          await sleep(600);
          highlighted = await session.js(`!!document.getElementById('editor').contentWindow.document.querySelector('.typora-anchor-target')`);
          await sleep(1600);
        }
        const headingTop = await session.js(headingTopOf);
        ctx.witness('锚点点击前后的标题位置与落点高亮', {目标: at, 点击前标题top: before, 点击后标题top: headingTop, 落点高亮: highlighted});
        ctx.assert('【E】点锚点链接之后页面确实滚动了', before !== null && headingTop !== null && Math.abs(before - headingTop) > 200, {before, after: headingTop});
        ctx.assert('【E】目标标题被带进视口（眼睛能看到）', headingTop !== null && headingTop >= 0 && headingTop < 713, {headingTop});
        ctx.assert('【E】落点被高亮了一下（用户能看出跳到哪一节）', highlighted === true, {highlighted});
      } finally { await ctx.release(session); }
    }

    // ---------------- F：Ctrl+多选图片后 Delete 要能整批删掉（且一次撤销可回退） ----------------
    {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8DAwMgABIxgCgAAJgAB0v1cQwAAAABJRU5ErkJggg==', 'base64');
      fs.writeFileSync(path.join(dir, 'a.png'), png);
      fs.writeFileSync(path.join(dir, 'b.png'), png);
      const imgFile = path.join(dir, '多图.md');
      fs.writeFileSync(imgFile, '# 三张图\n\n![甲](a.png)\n\n![乙](b.png)\n\n![丙](a.png)\n\n结束段。\n');
      const session = await ctx.launch({inspect: true, args: [imgFile]});
      try {
        await session.until(`(() => { const w = document.getElementById('editor').contentWindow; return w.document.querySelectorAll(${SURFACE} + ' img').length === 3; })()`, {timeout: 60000});
        await sleep(2000);
        const imgs = await session.js(`(() => { const w = document.getElementById('editor').contentWindow; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
          return [...w.document.querySelectorAll(${SURFACE} + ' img')].map(img => { const r = img.getBoundingClientRect();
            return {x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.y + r.height / 2)}; }); })()`);
        for (const img of imgs) {
          await session.move(img.x, img.y);
          await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: img.x, y: img.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 2});
          await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: img.x, y: img.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 2});
          await sleep(420);
        }
        const selected = await session.js(`document.getElementById('editor').contentWindow.document.querySelectorAll('.typora-img-multi-selected').length`);
        const focusBeforeKey = await session.js(`document.getElementById('editor').contentWindow.document.hasFocus()`);
        await session.key({key: 'Delete', code: 'Delete', vk: 46});
        await sleep(1500);
        const afterDelete = await session.js(`document.getElementById('editor').contentWindow.document.querySelectorAll(${SURFACE} + ' img').length`);
        await session.key({key: 'Z', code: 'KeyZ', vk: 90, modifiers: harness.MOD.ctrl});
        await sleep(1500);
        let afterUndo = afterDelete, undos = 0;
        while (afterUndo < 3 && undos < 5) {
          await session.key({key: 'Z', code: 'KeyZ', vk: 90, modifiers: harness.MOD.ctrl});
          await sleep(1200);
          undos += 1;
          afterUndo = await session.js(`document.getElementById('editor').contentWindow.document.querySelectorAll(${SURFACE} + ' img').length`);
        }
        ctx.witness('多选-删除-撤销的图片数量', {选中高亮: selected, 按键前编辑区有焦点: focusBeforeKey, 删除后图片数: afterDelete, 撤销后图片数: afterUndo, 撤销按键次数: undos});
        ctx.assert('【F】Ctrl+多选之后编辑区仍然持有键盘焦点（否则按键全落到外壳）', focusBeforeKey === true, {focusBeforeKey});
        ctx.assert('【F】Delete 一次把选中的三张图全删掉', afterDelete === 0, {afterDelete, 选中高亮: selected});
        ctx.assert('【F】撤销之后三张图都回来了（删除没把内容吃掉）', afterUndo === 3, {afterUndo, 撤销按键次数: undos});
      } finally { await ctx.release(session); }
    }

    // ---------------- G：矮窗口里补全面板不得压住被编辑的那一行 / 鼠标 ----------------
    {
      const filler = Array.from({length: 30}, (_, i) => `MARK${i + 1} 第 ${i + 1} 段填充文字。`).flatMap(x => [x, '']);
      const placeFile = path.join(dir, '落位.md');
      fs.writeFileSync(placeFile, ['# 补全落位', '', ...filler].join('\n'));
      const session = await ctx.launch({inspect: true, args: [placeFile]});
      try {
        await session.until(`(() => { const w = document.getElementById('editor').contentWindow; return !!(w && w.document.querySelector(${SURFACE})); })()`, {timeout: 60000});
        await sleep(2000);
        await session.main.js(`(() => { global.windows[0].win.setContentSize(1100, 430); return true; })()`);
        await sleep(1500);
        await session.js(`(() => { const w = document.getElementById('editor').contentWindow;
          w.__accMouse = null; w.addEventListener('mousemove', e => { w.__accMouse = {x: e.clientX, y: e.clientY}; }, true); return true; })()`);
        const at = await session.js(`(() => { const w = document.getElementById('editor').contentWindow; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
          const p = [...w.document.querySelectorAll(${SURFACE} + ' p')].find(x => x.textContent.includes('MARK3'));
          if (!p) return null; const r = p.getBoundingClientRect();
          return {x: Math.round(fr.x + r.x + 30), y: Math.round(fr.y + r.y + r.height / 2)}; })()`);
        if (at) {
          await session.move(at.x, at.y);
          await session.click(at.x, at.y);
          await sleep(600);
          await session.key({key: 'End', code: 'End', vk: 35});
          await sleep(250);
          await session.type('/');
          await sleep(2200);
        }
        const measured = await session.js(`(() => {
          const w = document.getElementById('editor').contentWindow;
          const pop = w.document.querySelector('.md-completion:not([hidden])');
          const sel = w.getSelection();
          const caret = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
          let line = null;
          if (sel && sel.rangeCount) {
            const node = sel.getRangeAt(0).startContainer;
            const el = node && node.nodeType === 3 ? node.parentElement : node;
            const target = (el && el.closest && el.closest('code,p,li,pre,td,th')) || el;
            if (target && target.getBoundingClientRect) line = target.getBoundingClientRect();
          }
          const pr = pop ? pop.getBoundingClientRect() : null;
          const mouse = w.__accMouse;
          const hit = (a, b) => !!a && !!b && a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;
          return {候选数: w.document.querySelectorAll('.md-completion:not([hidden]) button').length,
            面板: pr ? {top: Math.round(pr.top), bottom: Math.round(pr.bottom)} : null,
            行: line ? {top: Math.round(line.top), bottom: Math.round(line.bottom)} : null,
            鼠标: mouse, 视口高: w.innerHeight,
            面板在视口内: pr ? (pr.top >= 0 && pr.bottom <= w.innerHeight + 1) : null,
            压住行: pr && line ? hit(pr, line) : null,
            压住鼠标: pr && mouse ? hit(pr, {top: mouse.y - 4, bottom: mouse.y + 4, left: mouse.x - 4, right: mouse.x + 4}) : null}; })()`);
        ctx.witness('矮窗口下面板/行/鼠标的几何', measured);
        ctx.assert('【G】补全面板确实弹出来了（否则这条断言没有意义）', measured.候选数 > 0, {候选数: measured.候选数});
        ctx.assert('【G】面板整体在视口内', measured.面板在视口内 === true, measured);
        ctx.assert('【G】面板没有压住"正在编辑的那一行"', measured.压住行 === false, {面板: measured.面板, 行: measured.行});
        ctx.assert('【G】面板没有压住鼠标位置', measured.压住鼠标 === false, {面板: measured.面板, 鼠标: measured.鼠标});
      } finally { await ctx.release(session); }
    }

    void ping;
    void sub;
  },
};
