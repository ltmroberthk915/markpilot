import { ChangeSet, Text, Transaction, Annotation } from '@codemirror/state';

/* 可信远端标记：仅由本模块的 apply 通道（权威已入账的共享增量回放）打上。
 * 图片删除守卫等本地策略据此放行——源窗口已按完整选项确认过、authority 已收下这笔变更，
 * 接收端不再弹重复的删除对话框（否则接收窗整篇保旧、本客户端却升版本 ⇒ 静默分叉）。
 * 普通本地事务一律不带此标记，删除确认的三个选项与取消路径不受影响。 */
export const liveRemoteAccepted = Annotation.define();

/* MarkPilot CM Live — 共享文档的 CM6 侧客户端（desktop 腿）。
 *
 * 契约口径（与桌面壳 preload IPC、DSH 插件路由同形，见桌面腿 API 文档）：
 *  · facade：bind/unbind/flush/status/refresh；transport 由宿主注入
 *    （EXE 走 preload IPC live:*；DSH 插件走自己的服务路由，信封同形）。
 *  · 只做增量交换（{from,to,insert} 列表），绝不全文轮询。
 *  · 远端事务带 Transaction.remote + addToHistory:false —— 不进本地撤销，
 *    Ctrl+Z 只撤自己的编辑；光标/选区由 CM6 原生映射。
 *  · 组字（IME）期间不应用远端、不上行本端；组字结束后立即补发。
 *  · 歧义替换（与未确认本地增量重叠）→ MP_LIVE_CONFLICT，halt + onError，
 *    草稿保留，绝不推断合并、绝不静默覆盖。
 *  · savedVersion 前进本身不消脏：清脏唯一条件是 version===savedVersion && pending===0 && !error。
 */

function difference(before, after) {
  let start = 0, end = before.length, nextEnd = after.length;
  while (start < end && start < nextEnd && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  while (end > start && nextEnd > start && before.charCodeAt(end - 1) === after.charCodeAt(nextEnd - 1)) { end--; nextEnd--; }
  return ChangeSet.of(start === end && start === nextEnd ? [] : {from:start, to:end, insert:after.slice(start,nextEnd)}, before.length);
}

function parts(change) {
  const result = [];
  change.iterChanges((from, to, _nextFrom, _nextTo, inserted) => result.push({from,to,insert:inserted.toString()}));
  return result;
}

// Two concurrent insertions at one boundary have a deterministic order. A
// replacement inside someone else's replacement has no safe inferred meaning.
function ambiguous(local, remote) {
  const left = parts(local), right = parts(remote);
  let j = 0;
  for (const a of left) {
    while (j < right.length && right[j].to <= a.from && right[j].from !== a.from) j++;
    for (let k=j; k<right.length && right[k].from <= a.to; k++) {
      const b = right[k];
      if (a.from === a.to && b.from < a.from && a.from < b.to ||
          b.from === b.to && a.from < b.from && b.from < a.to ||
          Math.max(a.from,b.from) < Math.min(a.to,b.to) && (a.insert || b.insert)) return true;
    }
  }
  return false;
}

const conflict = (message) => Object.assign(new Error(message), {code:'MP_LIVE_CONFLICT'});
const fatal = (code, message) => Object.assign(new Error(message), {code});
// Authority/session integrity failures stop the client; transient transport
// errors (no code / unknown code) retry with backoff until the ceiling.
const isFatalCode = (code) => typeof code === 'string' &&
  (code.startsWith('MP_LIVE_') || code.startsWith('MP_FILE_') || code.startsWith('MP_DOC_'));
const TRANSPORT_CEILING = 10;

/* 恢复副本通知（加入票 recovered 字段）：同一页面生命周期内按 (recoveryPath,sha256,at)
 * 去重——重复加入/重绑不重复提示（交换节拍 ~160ms 也不会刷屏）。仅上报给宿主，
 * 不自动打开、不触碰原件、不授予任何路径访问。 */
const seenRecovered = new Set();
function notifyRecovered(transport, joined) {
  if (typeof transport.onRecovered !== 'function') return;
  const list = Array.isArray(joined.recovered) ? joined.recovered : [];
  const fresh = [];
  for (const entry of list) {
    if (!entry || typeof entry.recoveryPath !== 'string' || !entry.recoveryPath) continue;
    const key = entry.recoveryPath + '\u0000' + (entry.sha256 || '') + '\u0000' + (entry.at || 0);
    if (seenRecovered.has(key)) continue;
    seenRecovered.add(key);
    fresh.push({ recoveryPath: entry.recoveryPath, sha256: entry.sha256 || null, at: entry.at || null });
  }
  if (fresh.length) { try { transport.onRecovered(fresh); } catch { /* 宿主 UI 异常不影响加入 */ } }
}

export function createLiveDocument({getView, composing, apply}) {
  let current = null;

  function status(s = current) {
    return s && {client:s.client, epoch:s.epoch, version:s.version, savedVersion:s.savedVersion, diskHash:s.diskHash,
      pending:s.pending.length, error:s.error?.message || null, conflict:!!s.error};
  }
  function changed(s) { if (s === current) s.transport.onStatus?.(status(s)); }
  function halt(s,error) {
    if (s === current && !s.error) {
      s.error = error; clearTimeout(s.timer); s.failures = 0;
      s.transport.onError?.(error.message,error.code || 'MP_LIVE_CONFLICT');
      changed(s);
    }
  }
  function poll(s,delay) {
    if (s !== current || s.error) return;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { void update(s).catch(()=>{}); }, delay);
  }
  function schedule(s) {
    poll(s, s.pending.length && !composing() ? 0 : (globalThis.document?.hidden ? 900 : 160));
  }
  function observe(u) {
    const s = current;
    if (!s || s.error || !u.docChanged || u.transactions.every(t=>!t.docChanged || t.annotation(Transaction.remote))) return;
    const tail = s.pending.at(-1);
    if (tail && !tail.sent) {
      tail.delta = tail.delta.compose(u.changes);
      // Compose 能在「未上行的那一笔」上把本地编辑正好抵消成空增量：剪切 → 撤销
      // → 重做就是常见组合。空 delta 从未发给权威，且协议要求 changes 非空；若把它
      // 留在 queue 里，flush/保存会以 MP_LIVE_CHANGE 失败（实测：Ctrl+S 报“无效的
      // 协同编辑”，磁盘不落盘）。这笔净零编辑直接丢弃，并把预分配的 seq 退回，
      // 保持后续序号与权威的 lease.seq+1 连续。
      if (tail.delta.empty) { s.pending.pop(); s.seq--; schedule(s); return; }
    } else s.pending.push({seq:++s.seq, delta:u.changes, sent:false});
    schedule(s);
  }
  function remote(s,delta) {
    let effect = delta;
    for (const p of s.pending) {
      if (ambiguous(p.delta,effect)) throw conflict('另一窗口同时修改了同一段内容。已保留当前草稿，请另存为或重新载入。');
      const local = p.delta;
      // The authority has committed the remote insertion first.
      p.delta = local.map(effect);
      effect = effect.map(local,true);
    }
    if (!effect.empty) {
      // 接收端应用后校验：若这笔权威增量被本地策略（图片删除守卫、其它过滤器）拦下，
      // 绝不能当成已应用——在这里 halt 保草稿，也不把版本确认给 authority。
      const before = getView().state.doc;
      const expected = effect.apply(before);
      apply(effect);
      if (!getView().state.doc.eq(expected))
        throw conflict('共享修改被本窗口的图片删除保护等策略拦下，未能应用；已保留当前草稿。');
    }
  }
  function receive(s,r) {
    if (r.epoch !== s.epoch || !Array.isArray(r.updates) || !Number.isSafeInteger(r.version))
      throw conflict('共享文档的编辑版本已改变，请保留草稿后重新载入。');
    for (const u of r.updates) {
      if (u.version !== s.version+1) throw conflict('缺少共享编辑记录，请保留草稿后重新载入。');
      const accepted = ChangeSet.of(u.changes,s.length);
      if (u.client === s.client) {
        const head=s.pending[0];
        if (!head?.sent || head.seq !== u.seq || JSON.stringify(parts(head.delta)) !== JSON.stringify(parts(accepted)))
          throw conflict('收到不匹配的共享编辑回执，已保留当前草稿。');
        s.pending.shift();
      } else remote(s,accepted);
      s.length=accepted.newLength; s.version=u.version;
    }
    if (s.version !== r.version) throw conflict('共享编辑记录不完整，已保留当前草稿。');
    s.savedVersion=r.savedVersion; s.diskHash=r.diskHash;
  }
  function applyJoin(s) {
    const joined=s.joined;
    if (!joined || composing()) return;
    const delta=difference(s.initial,joined.text);
    if (!delta.empty) remote(s,delta);
    s.length=joined.text.length; s.version=joined.version;
    s.savedVersion=joined.savedVersion; s.diskHash=joined.diskHash;
    s.initial=null; s.joined=null;
  }
  async function cycle(s) {
    await s.ready;
    if (s !== current || s.error || composing()) return;
    applyJoin(s);
    if (s.reply) { receive(s,s.reply); s.reply=null; }
    const head=s.pending[0], request={epoch:s.epoch,version:s.version};
    if (head) { head.sent=true; request.seq=head.seq; request.changes=parts(head.delta); }
    const r=await s.transport.exchange(s.client,request);
    if (s !== current) return;
    if (!r || r.ok === false) throw Object.assign(new Error(r?.error || '共享编辑服务没有响应'), {code:r?.code});
    // Never dispatch against a live IME preedit, including when it began while
    // the request was in flight. New local edits remain in the same queue.
    if (composing()) s.reply=r;
    else receive(s,r);
    s.failures=0;
    changed(s);
  }
  function update(s) {
    if (s !== current || s.error) return Promise.reject(s.error || conflict('文档已切换'));
    if (s.flight) return s.flight;
    let retry=false;
    s.flight=cycle(s).catch(e=>{
      if (isFatalCode(e.code) || e instanceof RangeError || !!s.joinError) halt(s,e);
      else {
        // Transient transport failure: bounded retries, then surface honestly —
        // a silently dead channel must never look like a working session.
        s.failures=(s.failures||0)+1;
        if (s.failures >= TRANSPORT_CEILING)
          halt(s,fatal('MP_LIVE_UNREACHABLE','共享编辑通道连续无响应，已停止同步；当前草稿已保留。'));
        else retry=true;
      }
      throw e;
    }).finally(()=>{s.flight=null; if (retry) poll(s,650); else schedule(s);});
    return s.flight;
  }
  function unbind() {
    const old=current;
    if (!old) return;
    current=null; clearTimeout(old.timer);
    if (old.client) void Promise.resolve(old.transport.leave(old.client)).catch(()=>{});
  }
  function bind(initialText,transport) {
    unbind();
    if (typeof initialText !== 'string' || !transport || typeof transport.join !== 'function' ||
        typeof transport.exchange !== 'function' || typeof transport.leave !== 'function')
      throw fatal('MP_LIVE_TRANSPORT','共享编辑通道不完整，已按单窗口模式继续。');
    const s=current={initial:initialText,transport,client:null,epoch:null,version:0,length:initialText.length,
      seq:0,pending:[],error:null,failures:0};
    const view=getView(), doc=view.state.doc, base=Text.of(initialText.split('\n'));
    if (!doc.eq(base)) s.pending.push({seq:++s.seq,delta:difference(initialText,doc.toString()),sent:false});
    s.ready=Promise.resolve().then(()=>transport.join()).then(j=>{
      if (j?.ok === false || !j?.client || typeof j.text !== 'string')
        throw Object.assign(new Error(j?.error || '无法加入共享编辑会话'), {code:j?.code});
      if (s !== current) { void Promise.resolve(transport.leave(j.client)).catch(()=>{}); return; }
      s.client=j.client; s.epoch=j.epoch; s.joined=j;
      notifyRecovered(transport, j);
    }).catch(e=>{s.joinError=true;throw e;});
    changed(s);
    return update(s);
  }
  async function flush() {
    const s=current;
    if (!s) return null;
    do {
      if (s !== current) throw fatal('MP_LIVE_SWITCH','文档已切换');
      if (composing()) throw fatal('MP_LIVE_COMPOSING','输入尚未完成，请稍候再保存');
      await update(s);
      if (s !== current) throw fatal('MP_LIVE_SWITCH','文档已切换');
      if (s.error) throw s.error;
      if (composing()) throw fatal('MP_LIVE_COMPOSING','输入尚未完成，请稍候再保存');
    } while (s.pending.length || s.reply || s.joined);
    return {client:s.client, epoch:s.epoch, version:s.version};
  }
  return {bind,unbind,observe,flush,status:()=>status(),refresh:()=>current ? update(current) : Promise.resolve()};
}
