/* Service worker: the only place that may talk to the local unitoolkit endpoint.
   A content script runs in the Canvas page, where Chrome's Local Network Access blocks
   requests to loopback and private addresses (and a CSP could block them too). An extension
   worker with host_permissions is not subject to the page's rules. */
const BASES = ['https://geekom.tail4fff58.ts.net', 'http://127.0.0.1:8791'];
let base;

/* These hosts are optional permissions, not declared ones: the store listing then asks for
   Canvas only, and the user grants the machine-local endpoint when they connect it. */
const originOf = b => `${b}/*`;

async function granted(b) {
  try { return await chrome.permissions.contains({ origins: [originOf(b)] }); }
  catch { return false; }
}

async function pickBase() {
  if (base !== undefined && base !== null) return base;
  base = null;
  for (const b of BASES) {
    if (!(await granted(b))) continue;
    try {
      const r = await fetch(`${b}/health`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) { base = b; return base; }
    } catch { /* try the next one */ }
  }
  return base;
}

// Must run from a user gesture; the panel's connect button provides it.
async function connect() {
  for (const b of BASES) {
    if (await granted(b)) { base = b; return { ok: true, base: b, already: true }; }
    try {
      if (await chrome.permissions.request({ origins: [originOf(b)] })) {
        base = b;
        return { ok: true, base: b };
      }
    } catch { /* next base */ }
  }
  return { ok: false, reason: 'no permission granted' };
}

chrome.permissions.onRemoved.addListener(() => { base = undefined; });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'connectLocal') {
    connect().then(reply);
    return true;
  }
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
