// 现场诊断：连上 CDP 查看外壳与 iframe 实际状态
const get = (url) => fetch(url).then((r) => r.json());

async function main() {
  const list = await get('http://127.0.0.1:9222/json/list');
  console.log('targets:', list.map((t) => `${t.type} ${t.title} ${t.url}`));
  const page = list.find((t) => t.type === 'page' && /\/shell/.test(t.url));
  if (!page) return;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  };
  await new Promise((r) => (ws.onopen = r), (rej) => (ws.onerror = rej));
  const call = (method, params) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  console.log('title:', await ev('document.title'));
  console.log('readyState:', await ev('document.readyState'));
  console.log('tree rows:', await ev('document.querySelectorAll("#tree .row").length'));
  console.log('active rows:', await ev('document.querySelectorAll("#tree .row.active").length'));
  console.log('iframe src:', await ev('document.getElementById("editor")?.src'));
  console.log('iframe display:', await ev('document.getElementById("editor")?.style.display'));
  console.log('iframe vditor:', await ev('!!document.getElementById("editor")?.contentWindow?.vditor'));
  console.log('iframe text:', await ev('(document.getElementById("editor")?.contentDocument?.querySelector(".vditor-reset")?.innerText || "EMPTY").slice(0, 80)'));
  console.log('iframe md:', await ev('(document.getElementById("editor")?.contentWindow?.vditor?.getValue() || "NO-VDITOR").slice(0, 80)'));
  console.log('ir node:', await ev('!!document.getElementById("editor")?.contentDocument?.querySelector(".vditor-ir")'));
  console.log('body text:', await ev('(document.getElementById("editor")?.contentDocument?.body?.innerText || "EMPTY").slice(0, 120)'));
  console.log('content html len:', await ev('document.getElementById("editor")?.contentDocument?.querySelector(".vditor-content")?.innerHTML.length'));
  console.log('content children:', await ev('[...document.getElementById("editor")?.contentDocument?.querySelector(".vditor-content")?.children || []].map(c => c.className).join(" | ")'));
  console.log('reset exists:', await ev('!!document.getElementById("editor")?.contentDocument?.querySelector(".vditor-reset")'));
  ws.close();
}
main().catch((e) => { console.error('diag failed:', e.message); process.exit(1); });
