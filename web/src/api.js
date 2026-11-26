// The admin key lives only in this module's memory: not localStorage, not a cookie.
// A page reload logs you out, which is the intended trade-off for a high-privilege key.
const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
let adminKey = '';
export const setAdminKey = (k) => { adminKey = k; };

async function call(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, { ...opts, headers: { 'content-type': 'application/json', 'x-admin-key': adminKey } });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || r.statusText);
  return j;
}

export const api = {
  tenants: () => call('/admin/tenants'),
  createTenant: (b) => call('/admin/tenants', { method: 'POST', body: JSON.stringify(b) }),
  patchTenant: (id, b) => call(`/admin/tenants/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  createKey: (id, label) => call(`/admin/tenants/${id}/keys`, { method: 'POST', body: JSON.stringify({ label }) }),
  usage: (days, tenantId) => call(`/admin/usage?days=${days}${tenantId ? `&tenantId=${tenantId}` : ''}`),
};

/** Streams a chat completion and reports routing metadata from response headers. */
export async function streamChat({ apiKey, model, prompt, onMeta, onToken, signal }) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText);
  onMeta({ tier: r.headers.get('x-gateway-tier'), model: r.headers.get('x-gateway-model'), cache: r.headers.get('x-gateway-cache'), hedged: r.headers.get('x-gateway-hedged') === '1', timing: r.headers.get('server-timing') });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop();
    for (const e of events) {
      const d = e.replace(/^data: /, '');
      if (d === '[DONE]') return;
      try {
        const j = JSON.parse(d);
        if (j.error) throw new Error(j.error.message);
        if (j.gateway) onMeta({ cost: j.gateway.cost_usd, saved: j.gateway.saved_usd, reasons: j.gateway.reasons });
        const t = j.choices?.[0]?.delta?.content;
        if (t) onToken(t);
      } catch (err) { if (err.message && !(err instanceof SyntaxError)) throw err; }
    }
  }
}
