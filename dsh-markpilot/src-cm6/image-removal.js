import { Transaction } from '@codemirror/state';
import { historyField } from '@codemirror/commands';

// Count occurrences, so removing one of two identical images still asks. The
// backup itself can safely share one file for their identical bytes.
export function removedImageSources(before, after) {
  const counts = new Map();
  for (const region of after) {
    const src = region.data.image.src;
    counts.set(src, (counts.get(src) || 0) + 1);
  }
  const removed = [];
  for (const region of before) {
    const src = region.data.image.src, count = counts.get(src) || 0;
    if (count) counts.set(src, count - 1);
    else removed.push(src);
  }
  return removed;
}

export function imageRemovalDialog({ count, filePath, backup, valid, finish }) {
  const panel = document.createElement('dialog');
  panel.className = 'mp-image-removal-dialog';
  panel.setAttribute('aria-labelledby', 'mp-image-removal-title');
  const heading = document.createElement('h3'); heading.id = 'mp-image-removal-title'; heading.textContent = '保留内嵌图片的备份？';
  const message = document.createElement('p');
  message.textContent = `此操作将移除 ${count} 张内嵌图片。可以先将图片备份到文档同目录的 assets 图片文件夹，再继续操作。`;
  const status = document.createElement('p'); status.className = 'mp-image-removal-status'; status.setAttribute('role', 'status');
  if (!filePath) status.textContent = '请先保存文档，才能备份到同目录。也可以直接继续或取消。';
  const actions = document.createElement('div'); actions.className = 'mp-image-removal-actions';
  const back = document.createElement('button'), direct = document.createElement('button'), cancel = document.createElement('button');
  for (const button of [back, direct, cancel]) button.type = 'button';
  back.dataset.imageRemoval = 'backup'; back.textContent = '备份后继续'; back.disabled = !filePath;
  direct.dataset.imageRemoval = 'direct'; direct.textContent = '直接继续';
  cancel.dataset.imageRemoval = 'cancel'; cancel.textContent = '取消';
  let busy = false, closed = false, watch, receipt = null;
  const close = () => { if (closed) return; closed = true; clearInterval(watch); panel.close(); panel.remove(); };
  const complete = proceed => { if (closed || busy && proceed) return; close(); finish(proceed, receipt); };
  direct.onclick = () => complete(true); cancel.onclick = () => complete(false);
  panel.addEventListener('cancel', event => { event.preventDefault(); complete(false); });
  back.onclick = async () => {
    if (busy || closed || !valid()) return;
    busy = true; back.disabled = direct.disabled = true;
    status.textContent = '正在备份图片…';
    try {
      const answer = await backup();
      if (closed) return;
      if (!valid()) { busy = false; complete(false); return; }
      if (!answer?.ok) throw new Error((answer?.error || '备份失败') + (answer?.files?.length ? `（已有 ${answer.files.length} 个备份文件保留在 assets 中）` : ''));
      receipt = answer;
      busy = false; complete(true);
    } catch (error) {
      if (closed) return;
      busy = false; back.disabled = !filePath; direct.disabled = cancel.disabled = false;
      status.textContent = '原图已保留。' + error.message;
      back.focus();
    }
  };
  actions.append(back, direct, cancel); panel.append(heading, message, status, actions);
  document.body.appendChild(panel); panel.showModal(); (filePath ? back : cancel).focus();
  watch = setInterval(() => { if (!valid()) { close(); finish(false); } }, 100);
  return close;
}

// Ordinary input is rejected by the final transaction filter, letting CM repair
// its native DOM. History explicitly bypasses filters, so it is also intercepted
// before view.update. Neither path mutates the document before the user's choice.
export function createImageRemovalGate({ getView, images, identity, bypass, afterApply,
  host = () => window.mpHost, path = () => window.__mpDocPath || null, prompt = imageRemovalDialog }) {
  let pending = null;
  const lost = transactions => removedImageSources(images(transactions[0].startState), images(transactions.at(-1).state));
  const valid = job => {
    const view = getView(), state = view?.state;
    return pending === job && view === job.view && view.dom.isConnected && !state.readOnly &&
      state.doc === job.doc && state.selection.eq(job.selection) &&
      state.field(historyField, false) === job.history && identity(state) === job.identity && path() === job.filePath;
  };
  const cancel = () => { const job = pending; pending = null; job?.close?.(); };
  function defer(transactions, sources) {
    const view = getView(), start = transactions[0].startState;
    if (!view || view.state.doc !== start.doc || pending) return;
    const job = pending = { view, transactions, sources, doc: start.doc, selection: start.selection,
      history: start.field(historyField, false), identity: identity(start), filePath: path(), close: null };
    queueMicrotask(async () => {
      if (!valid(job)) { if (pending === job) cancel(); return; }
      // Capture the host document identity before showing a choice. A replaced
      // document can never redirect this backup into another document's folder.
      let documentId = null;
      try {
        const current = await host()?.currentDoc?.();
        if (current?.filePath === job.filePath) documentId = current.documentId;
      } catch { /* Direct/cancel remain available when the host is unavailable. */ }
      if (!valid(job)) { if (pending === job) cancel(); return; }
      job.close = prompt({ count: sources.length, filePath: documentId ? job.filePath : null,
        valid: () => valid(job),
        backup: () => host()?.backupEmbeddedImages?.({ documentId, filePath: job.filePath, sources: [...new Set(sources)] }),
        finish: (proceed, receipt) => {
          const current = valid(job); if (pending === job) pending = null;
          if (!current) return;
          if (proceed) {
            let state = view.state;
            const replay = transactions.map(original => {
              const next = state.update({ changes: original.changes, selection: original.newSelection,
                effects: original.effects, annotations: original.annotations,
                scrollIntoView: original.scrollIntoView, filter: false });
              state = next.state; return next;
            });
            // A single private replay consumes this choice; no public bypass token.
            if (!state.doc.eq(transactions.at(-1).newDoc)) return;
            view.update(replay); afterApply?.();
            if (receipt?.ok) window.mpExtras?.toast?.(`已备份 ${receipt.files.length} 张图片到 assets 图片文件夹`);
          }
          view.focus();
        },
      });
    });
  }
  return {
    cancel,
    filter(transaction) {
      if (!transaction.docChanged) return transaction;
      if (bypass()) { cancel(); return transaction; }
      if (pending) return [];
      const sources = lost([transaction]);
      if (!sources.length) return transaction;
      defer([transaction], sources); return [];
    },
    dispatch(transactions, view) {
      if (bypass()) { cancel(); view.update(transactions); return; }
      if (transactions.some(transaction => transaction.docChanged)) {
        const sources = pending ? [] : lost(transactions);
        if (pending || sources.length) {
          if (!pending) defer(transactions, sources);
          // Undo/Redo are filter:false and have not edited a native DOM surface.
          view.update([view.state.update({ annotations: Transaction.addToHistory.of(false) })]);
          return;
        }
      }
      view.update(transactions);
      if (pending && !valid(pending)) cancel();
    },
  };
}
