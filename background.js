/* Service worker: the only place that may talk to the local unitoolkit endpoint.
   A content script runs in the Canvas page, where Chrome's Local Network Access blocks
   requests to loopback and private addresses (and a CSP could block them too). An extension
   worker with host_permissions is not subject to the page's rules. */
const BASES = ['https://geekom.tail4fff58.ts.net', 'http://127.0.0.1:8791'];
let base;

async function pickBase() {
  if (base !== undefined) return base;
  base = null;
  for (const b of BASES) {
    try {
      const r = await fetch(`${b}/health`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) { base = b; return base; }
    } catch { /* try the next one */ }
  }
  return base;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'localSearch') return false;
  (async () => {
    const b = await pickBase();
    if (!b) return reply({ ok: false, reason: 'endpoint unreachable' });
    try {
      const url = `${b}/search?course=${encodeURIComponent(msg.course)}` +
        `&q=${encodeURIComponent(msg.q)}&docs=1&limit=${msg.limit || 10}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return reply({ ok: false, reason: 'HTTP ' + r.status });
      reply({ ok: true, data: await r.json() });
    } catch (e) {
      reply({ ok: false, reason: String(e).slice(0, 120) });
    }
  })();
  return true; // keep the channel open for the async reply
});
