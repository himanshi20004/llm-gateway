import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setAdminKey, streamChat } from './api.js';

const usd = (n) => `$${Number(n ?? 0).toFixed(n >= 1 ? 2 : 4)}`;

function Login({ onDone }) {
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    setAdminKey(key);
    try { await api.tenants(); onDone(); } catch (e) { setAdminKey(''); setErr(e.message); }
  };
  return (
    <main className="login">
      <h1>Gateway console</h1>
      <p className="muted">Enter the admin key. It stays in memory only and is gone on reload.</p>
      <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="ADMIN_API_KEY" />
      <button onClick={submit}>Sign in</button>
      {err && <p className="err">{err}</p>}
    </main>
  );
}

function Tenants() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ name: '', budget: 5 });
  const [newKey, setNewKey] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api.tenants().then((r) => setRows(r.data)).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const run = (fn) => async () => { setErr(''); try { await fn(); await load(); } catch (e) { setErr(e.message); } };
  return (
    <section>
      {newKey && (
        <div className="banner">
          <b>New API key for {newKey.tenant}</b> (shown once)
          <code>{newKey.apiKey}</code>
          <button onClick={() => { navigator.clipboard?.writeText(newKey.apiKey); }}>Copy</button>
          <button className="ghost" onClick={() => setNewKey(null)}>Dismiss</button>
        </div>
      )}
      {err && <p className="err">{err}</p>}
      <table>
        <thead><tr><th>Tenant</th><th>Month spend / budget</th><th>RPM</th><th>Max tier</th><th>Status</th><th /></tr></thead>
        <tbody>
          {rows.map((t) => {
            const pct = t.monthlyBudgetUsd ? Math.min(100, (100 * t.spentUsd) / t.monthlyBudgetUsd) : 100;
            return (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <div className="meter" aria-label={`${pct.toFixed(0)}% of budget used`}><i style={{ width: `${pct}%` }} className={pct > 90 ? 'hot' : ''} /></div>
                  <span className="num">{usd(t.spentUsd)} / {usd(t.monthlyBudgetUsd)}</span>
                </td>
                <td className="num">{t.rpm}</td>
                <td>{t.maxTier}</td>
                <td>{t.status}</td>
                <td className="actions">
                  <button onClick={run(async () => setNewKey({ tenant: t.name, ...(await api.createKey(t.id, 'dashboard')) }))}>New key</button>
                  <button className="ghost" onClick={run(() => api.patchTenant(t.id, { status: t.status === 'active' ? 'suspended' : 'active' }))}>{t.status === 'active' ? 'Suspend' : 'Activate'}</button>
                </td>
              </tr>
            );
          })}
          {!rows.length && <tr><td colSpan="6" className="muted">No tenants yet.</td></tr>}
        </tbody>
      </table>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); run(() => api.createTenant({ name: form.name, monthlyBudgetUsd: Number(form.budget) }))(); }}>
        <input required maxLength={80} placeholder="New tenant name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input type="number" min="0" step="0.5" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} aria-label="Monthly budget in USD" />
        <button>Create tenant</button>
      </form>
    </section>
  );
}

function Usage() {
  const [days, setDays] = useState(7);
  const [u, setU] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.usage(days).then(setU).catch((e) => setErr(e.message)); }, [days]);
  if (err) return <p className="err">{err}</p>;
  if (!u) return <p className="muted">Loading…</p>;
  const saved = Math.max(0, u.baselineUsd - u.spendUsd);
  return (
    <section>
      <div className="row">
        <label>Window <select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
      </div>
      <div className="ledger">
        <div className="bar" aria-label="Spend versus all-premium baseline">
          <i style={{ width: u.baselineUsd ? `${(100 * u.spendUsd) / u.baselineUsd}%` : '0%' }} />
        </div>
        <p className="big num">{usd(u.spendUsd)} <span className="muted">of {usd(u.baselineUsd)} all-premium baseline</span></p>
        <p>Saved <b className="num good">{usd(saved)}</b> ({u.savingsPct}%) by routing and caching.</p>
      </div>
      <dl className="stats">
        {[['Requests', u.requests], ['Cache hit rate', `${u.cacheHitPct}%`], ['TTFT p50', u.ttftMs.p50 == null ? '–' : `${Math.round(u.ttftMs.p50)} ms`], ['TTFT p99', u.ttftMs.p99 == null ? '–' : `${Math.round(u.ttftMs.p99)} ms`], ['Hedged', u.hedged], ['Errors', u.errors]].map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd className="num">{v}</dd></div>
        ))}
      </dl>
      <table>
        <thead><tr><th>Tier</th><th>Requests</th><th>Spend</th></tr></thead>
        <tbody>{u.byTier.map((t) => <tr key={t.tier}><td>{t.tier}</td><td className="num">{t.requests}</td><td className="num">{usd(t.spendUsd)}</td></tr>)}</tbody>
      </table>
    </section>
  );
}

function Playground() {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('auto');
  const [prompt, setPrompt] = useState('What is the capital of France?');
  const [out, setOut] = useState('');
  const [meta, setMeta] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ctl = useRef(null);

  const send = async () => {
    ctl.current?.abort();
    ctl.current = new AbortController();
    setOut(''); setMeta({}); setErr(''); setBusy(true);
    try {
      await streamChat({ apiKey, model, prompt, signal: ctl.current.signal, onMeta: (m) => setMeta((p) => ({ ...p, ...m })), onToken: (t) => setOut((o) => o + t) });
    } catch (e) { if (e.name !== 'AbortError') setErr(e.message); }
    setBusy(false);
  };

  return (
    <section className="play">
      <input type="password" autoComplete="off" placeholder="Tenant API key (gw_…)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <div className="row">
        <select value={model} onChange={(e) => setModel(e.target.value)}>{['auto', 'cheap', 'mid', 'premium'].map((m) => <option key={m}>{m}</option>)}</select>
        <button disabled={busy || !apiKey} onClick={send}>Send</button>
        {busy && <button className="ghost" onClick={() => ctl.current?.abort()}>Cancel</button>}
      </div>
      <textarea rows="4" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      {err && <p className="err">{err}</p>}
      {(meta.tier || meta.model) && (
        <p className="route">
          routed to <b>{meta.tier}</b> → <b>{meta.model}</b> · cache {meta.cache}{meta.hedged ? ' · hedged' : ''}{meta.timing ? ` · ${meta.timing}` : ''}
          {meta.cost != null && <> · cost <span className="num">{usd(meta.cost)}</span>, saved <span className="num good">{usd(meta.saved)}</span></>}
          {meta.reasons?.length ? <><br /><span className="muted">why: {meta.reasons.join(', ')}</span></> : null}
        </p>
      )}
      {/* Model output is untrusted: rendered as text, never as HTML. */}
      <pre className="out">{out}</pre>
    </section>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState('tenants');
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <>
      <header>
        <h1>Gateway console</h1>
        <nav>{[['tenants', 'Tenants'], ['usage', 'Usage'], ['play', 'Playground']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : 'ghost'} onClick={() => setTab(k)}>{l}</button>)}</nav>
      </header>
      <main>{tab === 'tenants' ? <Tenants /> : tab === 'usage' ? <Usage /> : <Playground />}</main>
    </>
  );
}
