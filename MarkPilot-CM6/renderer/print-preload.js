/* 打印窗口的 preload：**渲染侧自己**判断"本地图片都就绪了"，再通过 IPC 上报主进程。
 *
 * 为什么非要这一层（实测踩坑）：
 *  主进程在打印窗口里调 `executeJavaScript` 会被 Chromium **排在文档 load 之后**——而 load 要等
 *  全部子资源，导出 HTML 里原样保留的外链图片在无外网时会挂到连接超时，于是主进程"问不到"
 *  渲染侧状态，实测白等 20–40s（两次都栽在这上面：轮询 readyState 39.8s、等图片 20s 超时）。
 *  preload 在文档创建时就进场，不受导航排队影响：图片就绪 → 立刻发一条 IPC。
 *
 * 只等**本地**图片（file:/data:/blob:）：外链图在离线导出里本来就取不回来，把它算进"就绪"没有意义；
 * 不用 requestAnimationFrame（隐藏窗口不一定有合成帧），用两个 setTimeout(0) 宏任务代替。
 */
'use strict';
const { ipcRenderer } = require('electron');

const isRemote = (img) => /^https?:/i.test(img.currentSrc || img.src || '');
const nextTask = () => new Promise((r) => setTimeout(r, 0));
/** 给任意 promise 加个上限：隐藏窗口里 `img.decode()` 可能永远不 settle（没有合成帧就没有"可绘制"时刻），
 *  不能让它把"就绪上报"拖死——超时就按已完成的算，并把 partial 标出来。 */
const cap = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

async function report() {
  let info = { total: 0, local: 0, remote: 0, complete: 0, natural: 0, broken: 0, readyState: document.readyState, partial: false };
  try {
    const all = Array.from(document.images || []);
    const local = all.filter((i) => !isRemote(i));
    const wait = (i) => new Promise((r) => {
      if (i.complete) return r();
      i.addEventListener('load', r, { once: true });
      i.addEventListener('error', r, { once: true });
    });
    const sequence = (async () => {
      await Promise.all(local.map(wait));
      // complete 只保证"有结果"，decode 完才算能画；逐个 decode 但每个最多等 300ms
      await Promise.all(local.map((i) => (i.decode ? cap(i.decode().catch(() => { }), 300) : Promise.resolve())));
      if (document.fonts && document.fonts.ready) await cap(document.fonts.ready.catch(() => { }), 3000);
      await nextTask();
      await nextTask();
    })();
    const settled = await cap(sequence.then(() => true), 5000);
    info = {
      total: all.length, local: local.length, remote: all.length - local.length,
      complete: local.filter((i) => i.complete).length,
      natural: local.filter((i) => i.naturalWidth > 0).length,
      broken: local.filter((i) => i.complete && i.naturalWidth === 0).length,
      remotePending: all.filter((i) => isRemote(i) && !i.complete).length,
      partial: settled !== true,
      readyState: document.readyState,
    };
  } catch (e) {
    info.error = String((e && e.message) || e);
  }
  try { ipcRenderer.send('mp:print-ready', info); } catch { /* 主进程已走开 */ }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void report(); }, { once: true });
else void report();
