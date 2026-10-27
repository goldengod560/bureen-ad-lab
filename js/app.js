import { h, render } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import htm from 'htm';
import { createBackend } from './data.js?v=51';
import * as R from './rules.js?v=51';
import { importHistory } from './importer.js?v=51';
import { readMetaFile, rowsForAd, sumRows, normName } from './metafile.js?v=51';

const html = htm.bind(h);
const be = createBackend();

// ---------- small helpers ----------
const byCreated = (a, b) => String(a.created_at).localeCompare(String(b.created_at));
const displayName = (ad) => ad.base_name + (ad.launched_on ? ' | ' + R.shortDate(ad.launched_on) : '');
const toneOf = (result) => (R.RESULTS[result] || {}).tone || 'muted';
const extOf = (file) => (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
let toastTimer;
const posterTried = new Set();

function Toast({ msg }) { return msg ? html`<div class="toast" role="status">${msg}</div>` : null; }

// A still frame from a video, used as its thumbnail (videos otherwise show as black squares).
async function videoPoster(src) {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto';
  if (typeof src === 'string') v.crossOrigin = 'anonymous';
  v.src = url;
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('Could not read the video')); setTimeout(() => rej(new Error('Timed out')), 20000); });
    await new Promise((res) => { v.onseeked = res; v.currentTime = Math.min(1, (v.duration || 3) / 3); setTimeout(res, 6000); });
    const w = 480, h = Math.round(w * (v.videoHeight || 480) / (v.videoWidth || 480));
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(v, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    if (!blob) throw new Error('No frame');
    return blob;
  } finally { if (typeof src !== 'string') URL.revokeObjectURL(url); }
}
const safeName = (s) => String(s || 'ad').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
async function downloadMedia(path, name) {
  const url = await be.mediaUrl(path); if (!url) throw new Error('File not found');
  const blob = await (await fetch(url)).blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = safeName(name) + '.' + (path.split('.').pop() || 'bin');
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function Media({ path, type, cls, onOpen, big, poster }) {
  const [url, setUrl] = useState(null);
  const isVid = /^video\//.test(type || '');
  const usePoster = !big && isVid && poster;
  const src = usePoster ? poster : path;
  useEffect(() => { let on = true; if (src) be.mediaUrl(src).then((u) => on && setUrl(u)).catch(() => {}); else setUrl(null); return () => { on = false; }; }, [src]);
  if (usePoster) return html`<span class=${'thumb ' + (cls || '')}>${url ? html`<img src=${url} alt="" loading="lazy" />` : html`<span>…</span>`}<span class="play"><svg width="8" height="8" viewBox="0 0 10 10"><path d="M2 1l7 4-7 4z" fill="#fff"/></svg></span></span>`;
  const inner = !path ? html`<span>No image</span>` : !url ? html`<span>…</span>`
    : isVid ? html`<video src=${url + '#t=0.1'} muted playsinline preload="metadata" controls=${!!big}></video>${!big && html`<span class="play"><svg width="8" height="8" viewBox="0 0 10 10"><path d="M2 1l7 4-7 4z" fill="#fff"/></svg></span>`}`
    : html`<img src=${url} alt="" loading="lazy" />`;
  if (big) return html`<button type="button" class="bigmedia" onClick=${() => url && onOpen && onOpen(url, isVid)} aria-label="Enlarge">${inner}</button>`;
  return html`<span class=${'thumb ' + (cls || '')}>${inner}</span>`;
}

function Lightbox({ item, onClose }) {
  if (!item) return null;
  return html`<div class="lightbox" onClick=${onClose}>${item.video ? html`<video src=${item.url} controls autoplay playsinline onClick=${(e) => e.stopPropagation()}></video>` : html`<img src=${item.url} alt="" />`}</div>`;
}

function Modal({ title, sub, wide, onClose, children }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  return html`<div class="scrim" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class=${'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true">
      <div class="mhead"><div class="stack" style="gap:2px"><h1>${title}</h1>${sub && html`<span class="muted small">${sub}</span>`}</div>
        <button class="btn ghost sm x" onClick=${onClose} aria-label="Close">Close</button></div>
      ${children}
    </div></div>`;
}

function Field({ label, full, children }) { return html`<label class=${'f' + (full ? ' full' : '')}><span>${label}</span>${children}</label>`; }

// ---------- app ----------
function App() {
  const [session, setSession] = useState(undefined);
  const [data, setData] = useState(null);
  const [pid, setPid] = useState(() => { try { return localStorage.getItem('adlab-pid'); } catch (e) { return null; } });
  const [view, setView] = useState('board');
  const [stage, setStageRaw] = useState(() => lsGet('adlab-stage', 'next'));
  const setStage = (k) => { setStageRaw(k); lsSet('adlab-stage', k); };
  const [modal, setModal] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

  const say = (m) => { setToast(m); clearTimeout(toastTimer); toastTimer = setTimeout(() => setToast(''), 2800); };
  const [loadErr, setLoadErr] = useState(null);
  const reload = async () => { try { const d = await be.loadAll(); d.ads = d.ads.map(R.normalizeAd); R.setStoreEcon(d.store); await closeOrphanTests(d); setData(d); setLoadErr(null); } catch (e) { setLoadErr(e.message); say('Could not load: ' + e.message); } };

  useEffect(() => {
    if (!be.configured) { setSession(null); return; }
    be.session().then(setSession);
    be.onAuth((s) => setSession(s));
  }, []);
  useEffect(() => { if (session) reload(); }, [session]);
  // Pull Shopify orders on its own when the last sync is over 2 hours old.
  useEffect(() => {
    if (!data || be.mock) return;
    const last = data.shop_days.reduce((m, r) => (String(r.synced_at) > m ? String(r.synced_at) : m), '');
    let skip = false; try { skip = localStorage.getItem('adlab-shop-off') === '1' && !last; } catch (e) {}
    if (skip || (last && Date.now() - new Date(last).getTime() < 2 * 3600e3)) return;
    be.syncShopify().then(reload).catch(() => { try { if (!last) localStorage.setItem('adlab-shop-off', '1'); } catch (e) {} });
  }, [data && data.shop_days.length, session]);
  useEffect(() => {
    // Any failed save shows a message instead of failing silently.
    const h = (e) => { const m = (e.reason && (e.reason.message || e.reason)) || 'unknown error'; say('Could not save: ' + m); reload(); };
    window.addEventListener('unhandledrejection', h);
    return () => window.removeEventListener('unhandledrejection', h);
  }, []);
  useEffect(() => { try { if (pid) localStorage.setItem('adlab-pid', pid); } catch (e) {} }, [pid]);
  // Make thumbnails for videos that don't have one yet, quietly in the background.
  useEffect(() => {
    if (!data) return;
    const todo = data.ads.filter((a) => a.media_path && /^video/.test(a.media_type || '') && !(a.tags && a.tags.poster) && !posterTried.has(a.id));
    if (!todo.length) return;
    let stop = false;
    (async () => {
      let made = 0;
      for (const ad of todo.slice(0, 12)) {
        if (stop) break; posterTried.add(ad.id);
        try {
          const url = await be.mediaUrl(ad.media_path); const blob = await videoPoster(url);
          const poster = await be.upload(ad.media_path.replace(/\.[^.]+$/, '') + '.poster.jpg', new File([blob], 'poster.jpg', { type: 'image/jpeg' }));
          await be.update('ads', ad.id, { tags: { ...(ad.tags || {}), poster } }); made++;
        } catch (e) { /* some browsers can't read some videos; skip */ }
      }
      if (made && !stop) reload();
    })();
    return () => { stop = true; };
  }, [data && data.ads.length]);

  if (!be.configured) return html`<div class="login"><div class="panel"><div class="brand"><i></i>BUREEN<b>AD LAB</b></div>
    <p>The app isn't connected to its database yet. Add the Supabase URL and anon key to <code>js/config.js</code>.</p>
    <p class="muted small">To try it without a database, open this page with <code>?mock=1</code> at the end of the address.</p></div></div>`;
  if (session === undefined) return html`<div class="login muted">Loading…</div>`;
  if (!session) return html`<${Login} />`;
  if (loadErr && !data) return html`<div class="login"><div class="panel"><div class="brand"><i></i>BUREEN<b>AD LAB</b></div>
    <div class="status bad">Couldn't load your ads: ${loadErr}</div>
    <p class="small muted">${/creatives|ads|relation|schema cache/i.test(loadErr) ? 'Your database needs the latest setup file. In Supabase, open SQL Editor, paste schema.sql from the repo and press Run, then refresh this page.' : 'Refresh the page. If it keeps happening, send Claude a screenshot of this message.'}</p>
    <div class="row"><button class="btn primary" onClick=${() => location.reload()}>Refresh</button><button class="btn ghost" onClick=${() => be.signOut()}>Sign out</button></div></div></div>`;
  if (!data) return html`<div class="login muted">Loading your ads…</div>`;

  const products = data.products.filter((p) => !p.archived).sort((a, b) => a.sort - b.sort);
  const product = products.find((p) => p.id === pid) || products[0];
  const ctx = { data, product, products, reload, say, setModal, setLightbox, busy, setBusy, setView };

  const activeStage1 = { length: testingCount(data) };
  const rules0 = R.rulesOf(product);
  const NAV = [['today', 'Today'], ['board', 'Board'], ['archive', 'Archive'], ['stats', 'Stats'], ['angles', 'Angles'], ['rules', 'Rules'], ['learn', 'Learnings'], ['more', 'More']];

  return html`
    <header class="top">
      <div class="brand"><i></i>BUREEN<b>AD LAB</b></div>
      <nav class="nav" aria-label="Sections">${NAV.map(([k, l]) => html`<button class=${view === k ? 'on' : ''} onClick=${() => setView(k)}>${l}</button>`)}</nav>
      <div class="right">
        ${be.mock && html`<span class="chip t-mid">Test mode</span>`}
        <span class="slots" title="Stage 1 tests live across all products"><span class="lbl">TEST SLOTS</span>
          ${Array.from({ length: Math.max(rules0.slots, activeStage1.length) }, (_, i) => html`<i class=${i < activeStage1.length ? 'on' : ''}></i>`)}
          <span class="mono">${activeStage1.length}/${rules0.slots}</span></span>
      </div>
    </header>
    <main class="wrap">
      ${data.missingTables && data.missingTables.length > 0 && html`<div class="banner"><b>One setup step left.</b> Stats needs two new database tables. In Supabase, open SQL Editor, paste <code>schema.sql</code> from the repo and press Run.</div>`}
      ${R.isWeekendLock() && html`<div class="banner"><b>Weekend lock.</b> Your rule: no new ads, reactivations or budget changes Friday night through Sunday.</div>`}
      ${['board', 'archive', 'angles', 'rules', 'learn'].includes(view) && html`<${ProductTabs} ...${ctx} setPid=${setPid} />`}
      ${view === 'board' && html`<${Board} key=${product.id} ...${ctx} stage=${stage} setStage=${setStage} />`}
      ${view === 'archive' && html`<${Archive} key=${product.id} ...${ctx} />`}
      ${view === 'today' && html`<${Today} ...${ctx} setPid=${setPid} />`}
      ${view === 'stats' && html`<${Stats} ...${ctx} />`}
      ${view === 'angles' && html`<${Angles} key=${product.id} ...${ctx} />`}
      ${view === 'rules' && html`<${Rules} key=${product.id} ...${ctx} />`}
      ${view === 'learn' && html`<${Learn} ...${ctx} />`}
      ${view === 'more' && html`<${More} ...${ctx} />`}
    </main>
    <nav class="bnav" aria-label="Main">${[['today', 'Today'], ['board', 'Board'], ['archive', 'Archive'], ['stats', 'Stats'], ['more', 'More']].map(([k, l]) => html`<button class=${view === k || (k === 'more' && (view === 'learn' || view === 'rules' || view === 'angles')) ? 'on' : ''} onClick=${() => setView(k)}>${l}</button>`)}</nav>
    ${modal && html`<${modal.type} ...${ctx} ...${modal.props} close=${() => setModal(null)} />`}
    <${Lightbox} item=${lightbox} onClose=${() => setLightbox(null)} />
    <${Toast} msg=${toast} />`;
}

function Login() {
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const go = async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { await be.signIn(email.trim(), pw); } catch (x) { const m = String((x && x.message) || x); setErr(/invalid login/i.test(m) ? 'Wrong email or password, or this user does not exist yet in Supabase (Authentication → Users).' : /not confirmed/i.test(m) ? 'This user is not confirmed yet. In Supabase, open Authentication → Users and confirm it.' : 'Sign-in failed: ' + m); } setBusy(false); };
  return html`<div class="login"><form class="panel" onSubmit=${go}>
    <div class="brand"><i></i>BUREEN<b>AD LAB</b></div>
    <${Field} label="Email"><input type="email" autocomplete="username" value=${email} onInput=${(e) => setEmail(e.target.value)} required /><//>
    <${Field} label="Password"><input type="password" autocomplete="current-password" value=${pw} onInput=${(e) => setPw(e.target.value)} required=${!be.mock} /><//>
    ${err && html`<div class="status bad">${err}</div>`}
    <button class="btn primary" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}</button>
    ${be.mock && html`<span class="muted small">Test mode: any email works. Nothing is saved to your real database.</span>`}
  </form></div>`;
}

function ProductTabs({ data, products, product, setPid, setModal }) {
  return html`<div class="ptabs" role="tablist" aria-label="Products">
    ${products.map((p) => { const n = data.ads.filter((a) => a.product_id === p.id && a.stage !== 'retired').length;
      return html`<button role="tab" aria-selected=${p.id === product.id} class=${'ptab' + (p.id === product.id ? ' on' : '')} onClick=${() => setPid(p.id)}>${p.name}<span class="n">${n}</span></button>`; })}
    <button class="ptab" style="border-style:dashed" onClick=${() => setModal({ type: ProductForm, props: {} })}>+ Add product</button>
  </div>`;
}

// ---------- board ----------
const PIPELINE = ['next', 'testing', 'bench', 'main'];
const FOLDERS = ['ideas', 'retest', 'exhausted', 'mid', 'failed', 'seasonal', 'retired'];
const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const shortMoney = (n) => (n == null ? '—' : n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : '$' + Math.round(n));

// File rows grouped by ad name, built once per data load.
const fileIndex = new WeakMap();
function fileTotals(ad, data) {
  let idx = fileIndex.get(data);
  if (!idx) { idx = new Map(); for (const r of data.meta_days || []) { const k = normName(r.ad_name); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(r); } fileIndex.set(data, idx); }
  const rows = idx.get(normName(ad.base_name));
  return rows ? sumRows(rows) : null;
}
// One set of numbers per ad: your Ads Manager files when they cover at least as much spend as the
// imported history and typed check-ins; otherwise the history.
function quickStats(ad, data) {
  const n = adNumbers(ad, data), f = fileTotals(ad, data);
  if (f && f.spend && f.spend >= n.spend - 1) return { spend: f.spend, buys: f.purchases, roas: f.roas, cpa: f.cpa, src: 'files' };
  if (!n.spend) return null;
  return { spend: n.spend, buys: n.buys, roas: n.rev / n.spend, cpa: n.buys ? n.spend / n.buys : null, src: 'history' };
}

// Running totals for a live test from the Ads Manager files, from the day it went live.
function liveFor(t, ad, data) {
  if (!ad || !t || !t.start_date || t.status !== 'active') return null;
  const from = (t.conditions || {}).spendFrom || t.start_date;
  const rows = rowsForAd(ad, data.meta_days || []).filter((r) => r.day >= from);
  if (!rows.length) return null;
  const s = sumRows(rows), through = rows.reduce((a, r) => (r.day > a ? r.day : a), '');
  return { m: R.metrics({ spend: s.spend, purchases: s.purchases, revenue: s.revenue, impressions: s.impressions || null, link_clicks: s.link_clicks || null, adds_to_cart: s.adds_to_cart || null, hook_plays: s.hook_plays || null, frequency: s.frequency }), day: R.daysBetween(t.start_date, through) + 1, through };
}

// ---------- Day-7 result vs. full run ----------
const mOf = (t) => R.metrics({ spend: t.spend, purchases: t.purchases, revenue: t.revenue, impressions: t.impressions || null, link_clicks: t.link_clicks || null, adds_to_cart: t.adds_to_cart || null, hook_plays: t.hook_plays || null, frequency: t.frequency });
// From your Ads Manager files: the standard window (partial launch day + days 1–7) and the full run
// (everything reported until the day you turned it off, same ad set). offOn overrides the saved off date.
function runsFor(test, ad, data, offOn) {
  if (!test || !ad || !test.start_date || test.stage !== 1) return null;
  const c = test.conditions || {}, p = data.products.find((x) => x.id === test.product_id), rules = R.rulesOf(p);
  const from = c.spendFrom || test.start_date, planned = test.planned_days || rules.plannedDays;
  const end = R.addDays(test.start_date, planned - 1), off = offOn || c.stoppedOn || null;
  let rows = rowsForAd(ad, data.meta_days || []).filter((r) => r.day >= from && (!off || r.day <= off));
  // Stick to the test's own ad set: the one with the most spend inside the window.
  const sets = new Map(); rows.filter((r) => r.day <= end).forEach((r) => { const k = r.campaign + '|' + r.adset; sets.set(k, (sets.get(k) || 0) + (+r.spend || 0)); });
  const key = [...sets.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0])[0];
  if (key) rows = rows.filter((r) => r.campaign + '|' + r.adset === key);
  if (!rows.length) return null;
  const win = rows.filter((r) => r.day <= end), after = rows.filter((r) => r.day > end);
  const spent = rows.filter((r) => +r.spend > 0).map((r) => r.day).sort();
  const lastN = (rules.collapseDays || 3);
  const last3 = sumRows(win.filter((r) => r.day > R.addDays(end, -lastN))).purchases;
  const d7 = win.length ? mOf(sumRows(win)) : null;
  const cls = d7 ? R.classify(d7, rules, R.today() > end ? { last3_purchases: last3 } : null) : null;
  return { from, end, off, d7, rule: cls && cls.result, evidence: cls && cls.evidence, full: mOf(sumRows(rows)), after: after.length ? mOf(sumRows(after)) : null,
    lastDay: spent[spent.length - 1] || null, windowDone: R.today() > end, rules };
}
function trendAfter(r) {
  if (!r || !r.after || !r.after.spend || !r.d7 || r.d7.roas == null || r.full.roas == null) return null;
  const ch = r.full.roas / r.d7.roas - 1;
  return ch >= 0.05 ? 'Improved after day 7' : ch <= -0.05 ? 'Slipped after day 7' : 'Held steady after day 7';
}
const isPassRes = (x) => x === 'pass' || x === 'strong_pass';
// Passed on day 7, but the full run fell under the fail line.
const slipped = (test, r) => r && isPassRes(test.result) && r.full.roas != null && r.after && r.after.spend > 0 && r.full.roas < r.rules.failRoas;
// Newer files changed what the rules say about the standard window since you finalized.
function lateChange(test, r) {
  const c = test.conditions || {};
  if (!r || !c.d7 || !c.d7.rule || !r.rule || test.status === 'active') return null;
  if (r.rule === c.d7.rule || c.lateAck === r.rule) return null;
  return { was: c.d7.rule, now: r.rule };
}
// Tests closed only because they were a double-click copy or replaced by a new launch: not real tests.
const isDupTest = (t) => t.status === 'stopped' && !t.result && /^(Duplicate of another live test|Replaced by a new launch)/.test(t.result_reason || '');
function lastStage1(ad, data) { return data.tests.filter((t) => t.ad_id === ad.id && t.stage === 1 && t.status !== 'active' && !isDupTest(t)).sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))[0] || null; }

// One stat line and at most one tag per card.
function cardInfo(ad, ctx) {
  const { data } = ctx;
  const product = data.products.find((p) => p.id === ad.product_id) || ctx.product;
  const tags = ad.tags || {};
  const q = quickStats(ad, data);
  const stats = q ? `${R.xroas(q.roas)} · ${R.money(q.cpa)} CPA · ${shortMoney(q.spend)}` : null;
  if (ad.stage === 'testing') {
    const t = data.tests.filter((x) => x.ad_id === ad.id && x.status === 'active')[0];
    if (!t) return { line: 'Open it to add the start date', chip: 'Needs start date', tone: 'mid', glow: 'live' };
    const st = R.testStatus(t, data.checkpoints.filter((c) => c.test_id === t.id), R.rulesOf(product), R.econOf(product).aov, liveFor(t, ad, data));
    const dl = st.day < 1 ? 'Partial day · Day 1 tomorrow' : `Day ${Math.min(st.day, st.planned)}/${st.planned}`;
    const line = st.m ? `${dl} · ${R.xroas(st.m.roas)} · ${st.m.purchases} buys` : st.day < 1 ? dl : `Day ${Math.min(st.day, st.planned)} of ${st.planned}`;
    const rr = st.day > st.planned ? runsFor(t, ad, data) : null;
    const line2 = rr && rr.after && rr.after.spend ? `Full run so far ${R.xroas(rr.full.roas)} · ${rr.full.purchases} buys` : null;
    if (st.early) return { line, line2, chip: 'Pause?', tone: 'fail', glow: 'live' };
    if (st.final) return { line, line2, chip: 'Finalize', tone: 'live', glow: 'live' };
    if (st.due.length) return { line, line2, chip: 'Results due', tone: 'mid', glow: 'live' };
    if (st.onTrack) return { line, line2, chip: 'On track', tone: 'pass', glow: 'live' };
    return { line, line2, chip: null, glow: 'live' };
  }
  // Finished tests: show the Day-7 result and the full run.
  if (['bench', 'mid', 'retest', 'failed'].includes(ad.stage)) {
    const lt = lastStage1(ad, data), rr = lt && runsFor(lt, ad, data);
    if (rr && rr.d7) {
      const base = ad.stage === 'bench' ? { tone: 'pass', glow: 'pass', chip: ad.result === 'strong_pass' ? 'Strong' : null } : { chip: null };
      const lc = lateChange(lt, rr), sl = slipped(lt, rr);
      return { ...base, line: `Day 7 ${R.xroas(rr.d7.roas)} · ${rr.d7.purchases} buys`, line2: rr.after && rr.after.spend ? `Full run ${R.xroas(rr.full.roas)} · ${rr.full.purchases} buys` : null,
        ...(lc ? { chip: 'Check result', tone: 'mid' } : sl ? { chip: 'Slipped', tone: 'fail' } : {}) };
    }
  }
  if (ad.stage === 'main') {
    const trial = data.tests.some((x) => x.ad_id === ad.id && x.stage === 2 && x.status === 'active');
    const h = mainHealth(ad, data, product);
    const chip = trial ? ['On trial', 'live'] : tags.fatiguing ? ['Fatiguing', 'mid'] : h && h.money === 'below' ? ['Below break-even', 'fail'] : h && h.creative === 'fatigue' ? ['Possible fatigue', 'mid'] : null;
    return { line: stats || 'In Main', chip: chip && chip[0], tone: chip && chip[1], glow: tags.fatiguing ? 'mid' : 'pass' };
  }
  if (ad.stage === 'next') {
    const q = data.ads.filter((a) => a.stage === 'next' && a.product_id === ad.product_id).sort((a, b) => R.queueOf(a) - R.queueOf(b));
    return { line: stats || ad.angle || 'Ready to launch', chip: '#' + (q.findIndex((a) => a.id === ad.id) + 1), tone: 'live', glow: 'live' };
  }
  if (ad.stage === 'ideas') return { line: ad.angle || 'Idea', chip: tags.review ? `Check ${tags.review.score}` : null, tone: tags.review ? (tags.review.score >= 80 ? 'pass' : tags.review.score >= 60 ? 'mid' : 'fail') : 'muted' };
  if (ad.stage === 'retest') return { line: stats || ad.angle || '', chip: null };
  if (ad.stage === 'bench') return { line: stats || 'Passed', chip: ad.result === 'strong_pass' ? 'Strong' : null, tone: 'pass', glow: 'pass' };
  if (ad.stage === 'seasonal') return { line: stats || '', chip: tags.season || null, tone: 'ins' };
  return { line: stats || '', chip: null };
}

function Card(props) {
  const { ad, setModal, select, selected, onToggle, showStage } = props;
  const ci = cardInfo(ad, props);
  const t = ad.tags || {};
  const click = () => (select ? onToggle(ad.id) : setModal({ type: AdDetail, props: { adId: ad.id } }));
  const drag = (e) => { e.dataTransfer.setData('text/adlab', ad.id); e.dataTransfer.effectAllowed = 'move'; props.onDragState && props.onDragState(true); };
  const reorder = ad.stage === 'next' && props.onReorder;
  return html`<button type="button" class=${'tcard' + (ci.glow ? ' glow-' + ci.glow : '') + (selected ? ' sel' : '')} onClick=${click}
      draggable=${!select} onDragStart=${drag} onDragEnd=${() => props.onDragState && props.onDragState(false)}
      onDragOver=${reorder ? (e) => { if ([...e.dataTransfer.types].includes('text/adlab')) { e.preventDefault(); e.stopPropagation(); } } : null}
      onDrop=${reorder ? (e) => { e.preventDefault(); e.stopPropagation(); props.onReorder(e.dataTransfer.getData('text/adlab'), ad); } : null}>
    <span class="ti"><${Media} path=${ad.media_path} type=${ad.media_type} poster=${t.poster} />
      ${(showStage || ci.chip) && html`<span class=${'chip t-' + (showStage ? 'muted' : ci.tone || 'muted')}>${showStage ? R.stageLabel(ad.stage) : ci.chip}</span>`}
      ${select && html`<span class=${'check' + (selected ? ' on' : '')}>${selected ? '✓' : ''}</span>`}</span>
    <span class="tn">${displayName(ad)}</span>
    ${ci.line && html`<span class="tl">${ci.line}</span>`}
    ${ci.line2 && html`<span class="tl">${ci.line2}</span>`}
  </button>`;
}

// Sub-groups inside a folder. null = no grouping.
const GROUPS = {
  retest: [['Era 2 and later', (a) => a.setup_era !== 'era1'], ['Era 1 · old setup', () => true]],
  main: [['On trial', (a, c) => c.data.tests.some((t) => t.ad_id === a.id && t.stage === 2 && t.status === 'active')], ['Running', () => true]],
  mid: [['Era 2 and later', (a) => a.setup_era !== 'era1'], ['Era 1 · weak evidence', () => true]],
  failed: [['Era 2 and later', (a) => a.setup_era !== 'era1'], ['Era 1 · never a fair shot', () => true]],
};
function benchHealth(data, product) {
  const rules = R.rulesOf(product);
  const ads = data.ads.filter((a) => a.product_id === product.id);
  const bench = ads.filter((a) => a.stage === 'bench').length;
  const main = ads.filter((a) => a.stage === 'main');
  const fatiguing = main.filter((a) => a.tags && a.tags.fatiguing);
  return { bench, target: rules.benchTarget, main: main.length, fatiguing, low: bench < rules.benchTarget, urgent: fatiguing.length > 0 && bench < Math.max(1, rules.benchTarget) };
}

function SummaryStrip({ data, product }) {
  const econ = R.econOf(product), b1 = R.beAt(econ, econ.price), rules = R.rulesOf(product);
  const live = testingCount(data, product.id);
  const bh = benchHealth(data, product);
  return html`<div class="strip">
    <span>${b1 ? html`Break-even <b>${R.xroas(b1.roas)}</b> at $${econ.price}` : html`Break-even <em class="warn">costs not set</em>`}</span>
    <span>Up Next <b>${data.ads.filter((a) => a.product_id === product.id && a.stage === 'next').length}</b></span>
    <span>Testing <b>${live}/${rules.slots}</b> slots</span>
    <span>In Main <b>${bh.main}</b>${bh.fatiguing.length ? html` <em class="warn">${bh.fatiguing.length} fatiguing</em>` : ''}</span>
    <span class=${bh.urgent ? 'warn' : ''}>Bench <b>${bh.bench}/${bh.target}</b>${bh.urgent ? ' · low' : ''}</span>
  </div>`;
}

// Search, sort, filter. Shared by Board and Archive.
const SORTS = [['new', 'Newest'], ['roas', 'Best ROAS'], ['spend', 'Most spend'], ['name', 'Name']];
function useBrowse(key) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(() => lsGet('adlab-sort-' + key, 'new'));
  const [fmt, setFmt] = useState('all');
  const [angle, setAngle] = useState('');
  useEffect(() => lsSet('adlab-sort-' + key, sort), [sort]);
  const apply = (list, data) => {
    let out = list;
    if (fmt !== 'all') out = out.filter((a) => (fmt === 'video' ? a.format === 'video' || /^video/.test(a.media_type || '') : a.format !== 'video' && !/^video/.test(a.media_type || '')));
    if (angle) out = out.filter((a) => (a.angle || '') === angle);
    const qs = (a) => quickStats(a, data) || {};
    const by = { new: (a, b) => String(b.launched_on || b.created_at || '').localeCompare(String(a.launched_on || a.created_at || '')),
      roas: (a, b) => (qs(b).roas ?? -1) - (qs(a).roas ?? -1), spend: (a, b) => (qs(b).spend ?? 0) - (qs(a).spend ?? 0), name: (a, b) => a.base_name.localeCompare(b.base_name) };
    return [...out].sort(by[sort]);
  };
  const match = (a) => { const s = q.trim().toLowerCase(); return !s || [a.base_name, a.angle, a.concept, a.notes].some((x) => String(x || '').toLowerCase().includes(s)); };
  return { q, setQ, sort, setSort, fmt, setFmt, angle, setAngle, apply, match };
}
function Toolbar({ b, data, product, sel, setSel, extra }) {
  const [open, setOpen] = useState(false);
  const active = b.sort !== 'new' || b.fmt !== 'all' || b.angle;
  return html`<div class=${'toolbar' + (open ? ' open' : '')}>
    <input class="inp search" type="search" placeholder="Search ads" value=${b.q} onInput=${(e) => b.setQ(e.target.value)} aria-label="Search ads" />
    <button class=${'btn sm phone-only' + (active ? ' on' : '')} onClick=${() => setOpen(!open)}>Filter${active ? ' •' : ''}</button>
    <select class="inp" value=${b.sort} onChange=${(e) => b.setSort(e.target.value)} aria-label="Sort">${SORTS.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
    <select class="inp" value=${b.fmt} onChange=${(e) => b.setFmt(e.target.value)} aria-label="Format"><option value="all">Images + videos</option><option value="image">Images</option><option value="video">Videos</option></select>
    <select class="inp" value=${b.angle} onChange=${(e) => b.setAngle(e.target.value)} aria-label="Angle"><option value="">All angles</option>${allAngles(data, product).map((a) => html`<option value=${a}>${a}</option>`)}</select>
    <button class=${'btn sm' + (sel ? ' on' : '')} onClick=${() => setSel(sel ? null : [])}>${sel ? 'Cancel select' : 'Select'}</button>
    ${extra}
  </div>`;
}

// A Stage 1 test only stays open while its ad is in Testing. Ads moved out by hand close their test.
async function closeTestFor(ad, to, data) {
  if (!ad || to === 'testing') return;
  for (const t of data.tests.filter((x) => x.ad_id === ad.id && x.stage === 1 && x.status === 'active')) {
    await be.update('tests', t.id, { status: 'stopped', result_reason: `Moved to ${R.stageLabel(to)} by hand on ${R.today()}.` });
  }
}
async function closeOrphanTests(d) {
  const orphans = d.tests.filter((t) => t.stage === 1 && t.status === 'active' && (d.ads.find((a) => a.id === t.ad_id) || {}).stage !== 'testing');
  // Two open tests for one ad (double click): keep the one with check-ins, else the newest.
  const byAd = new Map();
  for (const t of d.tests.filter((x) => x.stage === 1 && x.status === 'active' && !orphans.includes(x))) { if (!byAd.has(t.ad_id)) byAd.set(t.ad_id, []); byAd.get(t.ad_id).push(t); }
  for (const list of byAd.values()) {
    if (list.length < 2) continue;
    const score = (t) => (d.checkpoints.some((c) => c.test_id === t.id) ? 1e15 : 0) + Date.parse(t.created_at || 0);
    const keep = list.reduce((a, b) => (score(b) > score(a) ? b : a));
    for (const t of list) if (t !== keep) { const patch = { status: 'stopped', result_reason: 'Duplicate of another live test.' }; try { await be.update('tests', t.id, patch); Object.assign(t, patch); } catch (e) {} }
  }
  for (const t of orphans) {
    const ad = d.ads.find((a) => a.id === t.ad_id);
    const patch = { status: 'stopped', result_reason: ad ? `Moved to ${R.stageLabel(ad.stage)} by hand.` : 'Ad deleted.' };
    try { await be.update('tests', t.id, patch); Object.assign(t, patch); } catch (e) { /* try again next load */ }
  }
}
const testingCount = (data, pid) => data.ads.filter((a) => a.stage === 'testing' && (!pid || a.product_id === pid)).length;

async function moveAds(ids, to, data, note) {
  for (const id of ids) {
    const ad = data.ads.find((a) => a.id === id); if (!ad || ad.stage === to) continue;
    await closeTestFor(ad, to, data);
    await be.update('ads', id, to === 'next' ? { stage: to, tags: { ...(ad.tags || {}), queue: Date.now() } } : { stage: to });
    try { await be.insert('decisions', { product_id: ad.product_id, ad_id: id, kind: 'move', choice: `Moved to ${R.stageLabel(to)}`, reason: note || '' }); } catch (e) { /* log only */ }
  }
}
function SelectBar({ sel, setSel, ctx }) {
  const { data, reload, say } = ctx;
  const [to, setTo] = useState('');
  if (!sel) return null;
  const go = async () => { if (!to || !sel.length) return; await moveAds(sel, to, data, 'Moved several at once'); await reload(); say(`Moved ${sel.length} to ${R.stageLabel(to)}`); setSel(null); };
  return html`<div class="selbar"><b>${sel.length} selected</b>
    <select class="inp" value=${to} onChange=${(e) => setTo(e.target.value)}><option value="">Move to…</option>${[...R.STAGES, ...R.SHELVES].map((s) => html`<option value=${s.key}>${s.label}</option>`)}</select>
    <button class="btn primary sm" disabled=${!to || !sel.length} onClick=${go}>Move</button><button class="btn ghost sm" onClick=${() => setSel(null)}>Cancel</button></div>`;
}

function useDropFiles(onFiles) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer && e.dataTransfer.types || [])].includes('Files');
    const enter = (e) => { if (!hasFiles(e)) return; depth++; setOver(true); };
    const leave = (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setOver(false); };
    const overH = (e) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; setOver(false); const fs = [...e.dataTransfer.files].filter((f) => /^(image|video)\//.test(f.type)); if (fs.length) onFiles(fs); };
    window.addEventListener('dragenter', enter); window.addEventListener('dragleave', leave); window.addEventListener('dragover', overH); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', overH); window.removeEventListener('drop', drop); };
  }, []);
  return over;
}

function Board(ctx) {
  const { data, product, stage, setStage, setModal, reload, say } = ctx;
  const b = useBrowse('board');
  const [sel, setSel] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [dropCol, setDropCol] = useState(null);
  const over = useDropFiles((files) => setModal({ type: BulkForm, props: { files } }));
  const ads = data.ads.filter((a) => a.product_id === product.id);
  const by = (k) => { const l = b.apply(ads.filter((a) => a.stage === k), data); return k === 'next' ? [...l].sort((x, y) => R.queueOf(x) - R.queueOf(y)) : l; };
  const cur = PIPELINE.includes(stage) ? stage : 'next';
  const toggle = (id) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  // Drop a card on an Up Next card: it goes just before that one.
  const onReorder = async (id, target) => {
    setDragging(false); if (!id || id === target.id) return;
    const src = data.ads.find((a) => a.id === id); if (!src) return;
    const q = by('next'); const i = q.findIndex((a) => a.id === target.id);
    const before = i > 0 ? R.queueOf(q[i - 1]) : R.queueOf(target) - 2000;
    const tq = R.queueOf(target);
    const pos = (Math.min(before, tq - 1) + tq) / 2;
    await be.update('ads', id, { stage: 'next', tags: { ...(src.tags || {}), queue: pos } });
    if (src.stage !== 'next') { try { await be.insert('decisions', { product_id: src.product_id, ad_id: id, kind: 'move', choice: 'Moved to Up Next', reason: 'Dragged' }); } catch (e) {} }
    await reload(); say('Up Next reordered');
  };
  const cctx = { ...ctx, select: !!sel, selected: false, onToggle: toggle, onDragState: setDragging, onReorder };
  const cardCtx = (ad) => ({ ...cctx, selected: !!sel && sel.includes(ad.id) });
  const dropTo = async (e, to) => { e.preventDefault(); setDropCol(null); setDragging(false); const id = e.dataTransfer.getData('text/adlab'); if (!id) return; await moveAds([id], to, data, 'Dragged'); await reload(); say('Moved to ' + R.stageLabel(to)); };
  const dz = (to) => ({ onDragOver: (e) => { if ([...e.dataTransfer.types].includes('text/adlab')) { e.preventDefault(); setDropCol(to); } }, onDragLeave: () => setDropCol(null), onDrop: (e) => dropTo(e, to) });
  const newAd = () => setModal({ type: AdForm, props: { mode: 'new' } });
  const upload = html`<button class="btn sm" onClick=${() => setModal({ type: MetaFileModal, props: {} })}>Add Ads Manager file</button><label class="btn sm"><input type="file" multiple accept="image/*,video/*" hidden onChange=${(e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) setModal({ type: BulkForm, props: { files: fs } }); }} />Upload many</label><button class="btn primary sm" onClick=${newAd}>+ New ad</button>`;
  const searching = b.q.trim().length > 0;
  const results = searching ? b.apply(ads.filter(b.match), data) : [];
  return html`
    <${SummaryStrip} data=${data} product=${product} />
    <${Toolbar} b=${b} data=${data} product=${product} sel=${sel} setSel=${setSel} extra=${upload} />
    ${dragging && html`<div class="droprow"><span class="small muted">Drop on a folder:</span>${FOLDERS.map((f) => html`<span class=${'dropchip' + (dropCol === f ? ' on' : '')} ...${dz(f)}>${R.stageLabel(f)}</span>`)}</div>`}
    ${searching ? html`<section class="panel"><div class="row"><h2>Search: ${results.length} ad${results.length === 1 ? '' : 's'}</h2><span class="muted small">across every folder</span></div>
        ${results.length ? html`<div class="agrid">${results.map((ad) => html`<${Card} key=${ad.id} ad=${ad} ...${cardCtx(ad)} showStage />`)}</div>` : html`<div class="empty">No ads match "${b.q}"</div>`}</section>`
    : html`
    <div class="board">
      ${PIPELINE.map((k) => { const s = R.STAGES.find((x) => x.key === k);
        return html`<section class=${'col ' + k + (dropCol === k ? ' dropping' : '')} aria-label=${s.label} ...${dz(k)}><h2>${s.label}<span>${by(k).length}</span></h2><div class="hint">${s.hint}</div>
          <${CardGroupsSel} stageKey=${k} list=${by(k)} ctx=${cctx} cardCtx=${cardCtx} limit=${4} /></section>`; })}
    </div>
    <div class="stagepick" role="tablist" aria-label="Stages">
      ${PIPELINE.map((k) => html`<button role="tab" aria-selected=${k === cur} class=${k === cur ? 'on' : ''} onClick=${() => setStage(k)}><b>${R.stageLabel(k)}</b><span>${by(k).length}</span></button>`)}
    </div>
    <div class="phonelist"><${CardGroupsSel} stageKey=${cur} list=${by(cur)} ctx=${cctx} cardCtx=${cardCtx} limit=${4} /></div>`}
    <${SelectBar} sel=${sel} setSel=${setSel} ctx=${ctx} />
    ${over && html`<div class="dropover"><div>Drop to add as new ads</div></div>`}`;
}
function CardGroupsSel({ stageKey, list, ctx, cardCtx, limit, grid }) {
  const [open, setOpen] = useState({});
  if (!list.length) return html`<div class="empty">Nothing here</div>`;
  const groups = GROUPS[stageKey] || [['', () => true]];
  const left = [...list];
  return groups.map(([label, fn]) => {
    const g = left.filter((a) => fn(a, ctx)); g.forEach((a) => left.splice(left.indexOf(a), 1));
    if (!g.length) return null;
    const shown = open[label] ? g : g.slice(0, limit);
    return html`${label && groups.length > 1 && html`<div class="grp"><span>${label}</span><span>${g.length}</span></div>`}
      <div class=${grid || 'cgrid'}>${shown.map((ad) => html`<${Card} key=${ad.id} ad=${ad} ...${cardCtx(ad)} />`)}</div>
      ${g.length > limit && html`<button class="link small" style="align-self:flex-start" onClick=${() => setOpen({ ...open, [label]: !open[label] })}>${open[label] ? 'Show less' : `Show all ${g.length}`}</button>`}`;
  });
}

function Archive(ctx) {
  const { data, product } = ctx;
  const b = useBrowse('archive');
  const [folder, setFolder] = useState(() => lsGet('adlab-folder', 'ideas'));
  const [sel, setSel] = useState(null);
  useEffect(() => lsSet('adlab-folder', folder), [folder]);
  const ads = data.ads.filter((a) => a.product_id === product.id);
  const count = (k) => ads.filter((a) => a.stage === k).length;
  const toggle = (id) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  const cctx = { ...ctx, select: !!sel, onToggle: toggle };
  const cardCtx = (ad) => ({ ...cctx, selected: !!sel && sel.includes(ad.id) });
  const searching = b.q.trim().length > 0;
  const list = searching ? b.apply(ads.filter((a) => FOLDERS.includes(a.stage) && b.match(a)), data) : b.apply(ads.filter((a) => a.stage === folder), data);
  const hint = { ideas: 'Drafts and new uploads. Tap one and choose "Ready: put in Up Next" when it is ready to launch.', retest: 'Ads that never got a fair shot. Queue one for a retest when you want to run it again.', exhausted: 'Worked, then fatigued. Revive one to the Bench after a long rest.', mid: 'Close but not a pass. Best ones to recycle with a fix.', failed: 'Did not work.', seasonal: 'Sale and holiday ads.', retired: 'Hidden from everything else.' };
  return html`
    <div class="row"><h1 style="font-size:30px">Archive</h1></div>
    <div class="folders">${FOLDERS.map((f) => html`<button class=${'folder' + (folder === f && !searching ? ' on' : '')} onClick=${() => { setFolder(f); b.setQ(''); }}><b>${R.stageLabel(f)}</b><span>${count(f)}</span></button>`)}</div>
    <${Toolbar} b=${b} data=${data} product=${product} sel=${sel} setSel=${setSel} />
    ${searching ? html`<div class="small muted">${list.length} match${list.length === 1 ? '' : 'es'} across the archive</div>` : html`<div class="small muted">${hint[folder]}</div>`}
    ${searching ? html`<div class="agrid">${list.map((ad) => html`<${Card} key=${ad.id} ad=${ad} ...${cardCtx(ad)} showStage />`)}</div>`
      : html`<div class="stack"><${CardGroupsSel} key=${folder} stageKey=${folder} list=${list} ctx=${cctx} cardCtx=${cardCtx} limit=${12} grid="agrid" /></div>`}
    <${SelectBar} sel=${sel} setSel=${setSel} ctx=${ctx} />`;
}

// ---------- bulk upload ----------
const cleanName = (file, fmt) => {
  const base = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /\|/.test(base) ? base : `${fmt === 'video' ? 'VID' : 'IMG'} | ${base} | V1`;
};
// 9:16 files pair with the 1:1 file of the same name (e.g. "olive stack" + "olive stack 9x16").
const VERT_TOKENS = /[\s._-]*(9[x_-]?16|916|stories|story|reels?|vertical|vert)\b/gi;
const VERT_TEST = /(9[x_-]?16|916|stories|story|reels?|vertical)/i;
const SQUARE_TOKENS = /[\s._-]*(1[x_-]?1|square|feed)\b/gi;
const pairKey = (name) => name.toLowerCase().replace(/\.[^.]+$/, '').replace(VERT_TOKENS, '').replace(SQUARE_TOKENS, '').replace(/[\s._-]+/g, ' ').trim();
async function aspectOf(file) {
  try {
    if (/^image/.test(file.type)) { const bm = await createImageBitmap(file); const r = bm.width / bm.height; bm.close && bm.close(); return r; }
    const url = URL.createObjectURL(file); const v = document.createElement('video'); v.preload = 'metadata'; v.src = url;
    const r = await new Promise((res) => { v.onloadedmetadata = () => res(v.videoWidth / v.videoHeight); v.onerror = () => res(null); setTimeout(() => res(null), 8000); });
    URL.revokeObjectURL(url); return r;
  } catch (e) { return null; }
}
function BulkForm(ctx) {
  const { files, data, product, close, reload, say } = ctx;
  const mk = (f) => { const fmt = /^video/.test(f.type) ? 'video' : 'image'; return { file: f, fmt, name: cleanName(f, fmt).replace(VERT_TOKENS, '').replace(/\s+\|/g, ' |'), url: URL.createObjectURL(f), story: null }; };
  const [items, setItems] = useState(() => files.map(mk));
  const [paired, setPaired] = useState(0);
  const [angle, setAngle] = useState(''); const [concept, setConcept] = useState(''); const [ready, setReady] = useState(false);
  const [prog, setProg] = useState(null);
  // Find 9:16 files and attach each to its 1:1 partner.
  useEffect(() => { (async () => {
    const withR = await Promise.all(files.map(async (f) => { const r = await aspectOf(f); return { f, r, vert: VERT_TEST.test(f.name) || (r != null && r < 0.75) }; }));
    const mains = withR.filter((x) => !x.vert), verts = withR.filter((x) => x.vert);
    const used = new Set(); const out = [];
    for (const m of mains) {
      const k = pairKey(m.f.name);
      const partner = verts.find((v) => !used.has(v) && pairKey(v.f.name) === k) || (mains.length === 1 && verts.length === 1 && !used.has(verts[0]) ? verts[0] : null);
      const it = mk(m.f); if (partner) { used.add(partner); it.story = partner.f; it.storyUrl = URL.createObjectURL(partner.f); }
      out.push(it);
    }
    verts.filter((v) => !used.has(v)).forEach((v) => out.push(mk(v.f)));
    if (used.size) { setItems(out); setPaired(used.size); }
  })(); }, []);
  const setStory = (i, fl) => setItems(items.map((x, j) => (j === i ? { ...x, story: fl, storyUrl: fl ? URL.createObjectURL(fl) : null } : x)));
  const go = async () => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i]; setProg(`Uploading ${i + 1} of ${items.length}…`);
      const stamp = `${product.id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const media_path = await be.upload(`${stamp}.${extOf(it.file)}`, it.file);
      const tags = { ...(ready ? { queue: Date.now() + i } : {}) };
      if (it.fmt === 'video') { try { const pb = await videoPoster(it.file); tags.poster = await be.upload(`${stamp}.poster.jpg`, new File([pb], 'poster.jpg', { type: 'image/jpeg' })); } catch (e) { /* thumbnail is optional */ } }
      if (it.story) tags.files = [{ path: await be.upload(`${stamp}-916.${extOf(it.story)}`, it.story), type: it.story.type, label: '9:16' }];
      await be.insert('ads', { product_id: product.id, base_name: it.name.trim() || it.file.name, format: it.fmt, angle: angle || null, concept: concept || null, offer: '$6 per shirt · 6 for $36 · Free shipping', media_path, media_type: it.file.type, stage: ready ? 'next' : 'ideas', version: 1, tags, history: {} });
    }
    await reload(); close(); say(`Added ${items.length} ad${items.length === 1 ? '' : 's'} to ${ready ? 'Up Next' : 'Ideas'}`);
  };
  const Thumb = ({ url, fmt }) => html`<span class="thumb">${fmt === 'video' ? html`<video src=${url + '#t=0.5'} muted playsinline preload="metadata"></video>` : html`<img src=${url} alt="" />`}</span>`;
  return html`<${Modal} wide title=${`Add ${items.length} ad${items.length === 1 ? '' : 's'}`} sub=${product.name + ' · they go to Ideas unless you tick Up Next'} onClose=${close}>
    ${paired > 0 && html`<div class="status good small">Matched ${paired} 9:16 file${paired > 1 ? 's' : ''} to ${paired > 1 ? 'their' : 'its'} 1:1 version.</div>`}
    <div class="bulk">${items.map((it, i) => html`<div class="bitem">
      <${Thumb} url=${it.url} fmt=${it.fmt} />
      <input class="inp" value=${it.name} onInput=${(e) => setItems(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Ad name" />
      ${it.story ? html`<span class="story"><${Thumb} url=${it.storyUrl} fmt=${/^video/.test(it.story.type) ? 'video' : 'image'} /><button class="link tiny" onClick=${() => setStory(i, null)}>9:16 ✕</button></span>`
        : html`<label class="btn sm ghost">+ 9:16<input type="file" accept="image/*,video/*" hidden onChange=${(e) => setStory(i, e.target.files[0] || null)} /></label>`}
      <button class="link small" style="color:var(--fail)" onClick=${() => setItems(items.filter((_, j) => j !== i))} aria-label="Remove">✕</button></div>`)}</div>
    <div><div class="tiny muted" style="margin-bottom:6px">Angle for all</div><${AnglePicker} value=${angle} onPick=${setAngle} product=${product} reload=${reload} say=${say} /></div>
    <div><div class="tiny muted" style="margin-bottom:6px">Concept for all (optional)</div><${ConceptPicker} value=${concept} onPick=${setConcept} product=${product} data=${data} reload=${reload} say=${say} /></div>
    <div class="form"><label class="chk"><input type="checkbox" checked=${ready} onChange=${(e) => setReady(e.target.checked)} /> Ready to launch: put them all in Up Next</label></div>
    ${prog && html`<div class="status live">${prog}</div>`}
    <div class="row"><button class="btn primary" disabled=${!!prog || !items.length} onClick=${go}>Add ${items.length} ad${items.length === 1 ? '' : 's'}</button><button class="btn ghost" onClick=${close}>Cancel</button></div>
  <//>`;
}

// ---------- ad detail ----------
// How every ad sharing this concept has done. Era 1 results are shown but not counted.
// Stats for a group of ads: how many, and how many worked (Era 2 and later, finished only).
function famStats(fam) {
  const counted = fam.filter((a) => a.setup_era !== 'era1' && !['ideas', 'next', 'retest', 'testing'].includes(a.stage));
  const won = counted.filter((a) => ['pass', 'strong_pass', 'held'].includes(a.result) || ['bench', 'main', 'exhausted'].includes(a.stage));
  return { fam, counted: counted.length, won: won.length, era1: fam.filter((a) => a.setup_era === 'era1').length };
}
const same = (x, y) => !!x && !!y && x.trim().toLowerCase() === y.trim().toLowerCase();
// Other ads with the same angle, the same concept, or both. Angle first: the message usually matters most.
function SimilarAds({ ad, data, setModal }) {
  const [by, setBy] = useState(() => { try { return localStorage.getItem('adlab-similar') || 'angle'; } catch (e) { return 'angle'; } });
  const [all, setAll] = useState(false);
  const pick = (k) => { setBy(k); setAll(false); try { localStorage.setItem('adlab-similar', k); } catch (e) {} };
  const others = data.ads.filter((a) => a.id !== ad.id);
  const groups = {
    angle: ad.angle ? others.filter((a) => same(a.angle, ad.angle)) : null,
    concept: ad.concept ? others.filter((a) => same(a.concept, ad.concept)) : null,
    both: ad.angle && ad.concept ? others.filter((a) => same(a.angle, ad.angle) && same(a.concept, ad.concept)) : null,
  };
  const label = { angle: 'Same angle', concept: 'Same concept', both: 'Both' };
  const fam = groups[by];
  if (!ad.angle && !ad.concept) return html`<div class="small muted">Pick an angle and a concept to see similar ads and how they did.</div>`;
  // Worked first, then the rest; newest first inside each.
  const rank = (a) => (['bench', 'main', 'exhausted'].includes(a.stage) || ['pass', 'strong_pass', 'held'].includes(a.result) ? 0 : a.stage === 'testing' ? 1 : 2);
  const list = fam ? fam.slice().sort((a, b) => rank(a) - rank(b) || String(b.launched_on || b.created_at || '').localeCompare(String(a.launched_on || a.created_at || ''))) : [];
  const st = fam ? famStats([ad, ...fam]) : null;
  const what = by === 'angle' ? ad.angle : by === 'concept' ? ad.concept : `${ad.angle} + ${ad.concept}`;
  return html`<div class="stack" style="gap:8px">
    <div class="row" style="gap:8px;flex-wrap:wrap"><h2 style="margin:0">Similar ads</h2><span class="spacer"></span>
      <div class="seg sm" role="group" aria-label="Similar by">${['angle', 'concept', 'both'].map((k) => html`<button class=${by === k ? 'on' : ''} disabled=${!groups[k]} onClick=${() => pick(k)}>${label[k]}${groups[k] ? ` (${groups[k].length})` : ''}</button>`)}</div></div>
    ${!fam ? html`<div class="small muted">Set the ${by === 'angle' ? 'angle' : by === 'concept' ? 'concept' : 'angle and concept'} first.</div>`
      : !fam.length ? html`<div class="small muted">No other ads with ${what} yet.</div>`
      : html`<div class="small"><b>${what}</b>: ${st.fam.length} ads including this one${st.counted ? ` · Era 2 and later: ${st.won} of ${st.counted} worked` : ' · none finished since Era 1'}${st.era1 ? ` · ${st.era1} from Era 1 (not counted)` : ''}</div>
      <div class="fam">${(all ? list : list.slice(0, 6)).map((f) => html`<button class="famitem" onClick=${() => setModal({ type: AdDetail, props: { adId: f.id } })}><${Media} path=${f.media_path} type=${f.media_type} poster=${f.tags && f.tags.poster} /><span class="small">${f.base_name}</span><span class=${'chip t-' + (f.result ? toneOf(f.result) : 'muted')}>${R.stageLabel(f.stage)}${f.setup_era === 'era1' ? ' · Era 1' : ''}</span></button>`)}</div>
      ${list.length > 6 && html`<button class="link small" style="align-self:flex-start" onClick=${() => setAll(!all)}>${all ? 'Show fewer' : `Show all ${list.length}`}</button>`}`}
  </div>`;
}
function conceptStats(data, concept) {
  if (!concept) return null;
  const fam = data.ads.filter((a) => a.concept && a.concept.trim().toLowerCase() === concept.trim().toLowerCase());
  const counted = fam.filter((a) => a.setup_era !== 'era1' && !['ideas', 'next', 'retest', 'testing'].includes(a.stage));
  const won = counted.filter((a) => ['pass', 'strong_pass', 'held'].includes(a.result) || ['bench', 'main', 'exhausted'].includes(a.stage));
  const lastRun = fam.map((a) => a.launched_on || '').filter(Boolean).sort().pop() || null;
  return { fam, counted: counted.length, won: won.length, era1: fam.filter((a) => a.setup_era === 'era1').length, lastRun };
}
const allAngles = (data, product) => R.anglesFor(product || data.products[0]);
async function addAngle(product, reload, say) {
  const name = (prompt('New angle name (keep the list short: only add a truly new message):', '') || '').trim();
  if (!name) return null;
  if (R.anglesFor(product).some((a) => a.toLowerCase() === name.toLowerCase())) { say('That angle already exists'); return null; }
  await be.update('products', product.id, { rules: { ...(product.rules || {}), extraAngles: [...((product.rules || {}).extraAngles || []), name] } });
  await reload(); say('Angle added'); return name;
}
function AngleExplain({ name }) {
  const hint = R.angleHint(name), ex = R.angleExamples(name);
  if (!hint) return null;
  return html`<div class="angx"><b>${name}:</b> ${hint}${ex.length ? html`<br/><span class="muted">Examples: ${ex.join(' · ')}</span>` : ''}</div>`;
}
function AngleGuide() {
  return html`<div class="angguide">${R.ANGLES.map((a) => html`<${AngleExplain} name=${a.name} />`)}</div>`;
}
// A dropdown whose options show a short explanation. Closed, it shows just the choice.
function RowSelect({ value, placeholder, options, onPick, onAdd, addLabel }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('touchstart', h);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('touchstart', h); };
  }, [open]);
  const cur = options.find((o) => o.name === value);
  return html`<div class="rsel" ref=${ref}>
    <button type="button" class=${'rsel-btn' + (value ? '' : ' empty')} onClick=${() => setOpen(!open)}>
      <span>${value || placeholder}</span><span class="caret">▾</span></button>
    ${cur && cur.desc && !open && html`<div class="rsel-desc">${cur.desc}</div>`}
    ${open && html`<div class="rsel-list">
      ${options.map((o) => html`<button type="button" class=${'rsel-opt' + (o.name === value ? ' on' : '')} onClick=${() => { onPick(o.name === value ? '' : o.name); setOpen(false); }}>
        <span class="t"><b>${o.name}</b><span>${o.desc}</span></span>${o.extra || ''}</button>`)}
      ${onAdd && html`<button type="button" class="rsel-opt add" onClick=${async () => { setOpen(false); const n = await onAdd(); if (n) onPick(n); }}><span class="t"><b>${addLabel}</b></span></button>`}
    </div>`}
  </div>`;
}
function AnglePicker({ value, onPick, product, reload, say }) {
  const options = allAngles(null, product).map((c) => { const ex = R.angleExamples(c); return { name: c, desc: ex.length ? ex.slice(0, 2).join(' · ') : (R.angleHint(c) || 'Added by you') }; });
  return html`<${RowSelect} value=${value} placeholder="Choose the angle…" options=${options} onPick=${onPick} onAdd=${() => addAngle(product, reload, say)} addLabel="+ Add angle" />`;
}
const allConcepts = (data, product) => R.conceptsFor(product || (data && data.products[0]));
async function addConcept(product, reload, say) {
  const name = (prompt('New concept (a new kind of picture or video, not a new ad):', '') || '').trim();
  if (!name) return null;
  if (R.conceptsFor(product).some((a) => a.toLowerCase() === name.toLowerCase())) { say('That concept already exists'); return null; }
  await be.update('products', product.id, { rules: { ...(product.rules || {}), extraConcepts: [...((product.rules || {}).extraConcepts || []), name] } });
  await reload(); say('Concept added'); return name;
}
function ConceptPicker({ value, onPick, product, data, reload, say }) {
  const options = allConcepts(data, product).map((c) => { const info = R.conceptInfo(c); const mine = data.ads.filter((a) => a.concept === c && a.media_path).slice(0, 3);
    return { name: c, desc: info ? info.hint : 'Added by you', extra: html`<span class="minis">${mine.map((a) => html`<${Media} path=${a.media_path} type=${a.media_type} poster=${a.tags && a.tags.poster} />`)}</span>` }; });
  return html`<${RowSelect} value=${value} placeholder="Choose the concept…" options=${options} onPick=${onPick} onAdd=${() => addConcept(product, reload, say)} addLabel="+ Add concept" />`;
}

function ConceptPanel({ ad, data, reload, say, setModal }) {
  const [val, setVal] = useState(ad.concept || '');
  const [ang, setAng] = useState(ad.angle || '');
  const saveAng = async () => { if ((ang || '') === (ad.angle || '')) return; await be.update('ads', ad.id, { angle: ang.trim() || null }); await reload(); say('Angle saved'); };
  const prod = data.products.find((p) => p.id === ad.product_id);
  const angles = allAngles(data, prod);
  const save = async () => { if ((val || '') === (ad.concept || '')) return; await be.update('ads', ad.id, { concept: val.trim() || null }); await reload(); say('Concept saved'); };
  return html`<div class="panel"><div class="row"><h2>Angle</h2><span class="spacer"></span>
      <select class="inp" style="max-width:240px;min-height:34px" value=${ang} onChange=${async (e) => { const v = e.target.value; setAng(v); await be.update('ads', ad.id, { angle: v || null }); await reload(); say('Angle saved'); }} aria-label="Angle">
        <option value="">Not set</option>${[...angles, ...(ad.angle && !angles.includes(ad.angle) ? [ad.angle] : [])].map((c) => html`<option value=${c}>${c}</option>`)}</select></div>
    ${ang && html`<${AngleExplain} name=${ang} />`}
    <div class="row"><h2>Concept</h2><span class="spacer"></span>
      <select class="inp" style="max-width:240px;min-height:34px" value=${val} onChange=${async (e) => { const v = e.target.value; setVal(v); await be.update('ads', ad.id, { concept: v || null }); await reload(); say('Concept saved'); }} aria-label="Concept">
        <option value="">Not set</option>${[...allConcepts(data, prod), ...(ad.concept && !allConcepts(data, prod).includes(ad.concept) ? [ad.concept] : [])].map((c) => html`<option value=${c}>${c}</option>`)}</select></div>
    ${val && R.conceptInfo(val) && html`<div class="angx"><b>${val}:</b> ${R.conceptInfo(val).hint}</div>`}
    <${SimilarAds} ad=${ad} data=${data} setModal=${setModal} />
  </div>`;
}

function MediaGallery({ ad, setLightbox, reload, say }) {
  const tags = ad.tags || {};
  const files = [{ path: ad.media_path, type: ad.media_type, label: '1:1', main: true }, ...((tags.files || []).map((x) => ({ ...x })))].filter((x) => x.path);
  const [i, setI] = useState(0);
  const cur = files[Math.min(i, files.length - 1)];
  const [busy, setBusy] = useState(false);
  const add = async (fl) => {
    if (!fl) return; setBusy(true);
    try {
      const label = prompt('Label for this file (for example 9:16 or Story):', '') || '';
      const path = await be.upload(`${ad.product_id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${extOf(fl)}`, fl);
      await be.update('ads', ad.id, { tags: { ...tags, files: [...(tags.files || []), { path, type: fl.type, label }] } }); await reload(); say('File added'); setI(files.length);
    } catch (e) { say('Could not add: ' + e.message); }
    setBusy(false);
  };
  const removeCur = async () => { if (cur.main) return; await be.update('ads', ad.id, { tags: { ...tags, files: (tags.files || []).filter((x) => x.path !== cur.path) } }); setI(0); await reload(); say('File removed'); };
  const makeMain = async () => {
    if (cur.main) return;
    const rest = (tags.files || []).filter((x) => x.path !== cur.path);
    const old = ad.media_path ? [{ path: ad.media_path, type: ad.media_type, label: 'Old main' }] : [];
    const t = { ...tags, files: [...old, ...rest] }; delete t.poster;
    await be.update('ads', ad.id, { media_path: cur.path, media_type: cur.type, tags: t }); setI(0); await reload(); say('Set as main');
  };
  const copyName = async () => { try { await navigator.clipboard.writeText(ad.launched_on ? displayName(ad) : ad.base_name); say('Name copied'); } catch (e) { say('Could not copy'); } };
  return html`<div class="stack" style="gap:8px">
    ${cur ? html`<${Media} big path=${cur.path} type=${cur.type} onOpen=${(url, video) => setLightbox({ url, video })} />` : html`<div class="bigmedia empty">No image yet</div>`}
    ${files.length > 1 && html`<div class="gallery">${files.map((x, j) => html`<button class=${'gthumb' + (j === i ? ' on' : '')} onClick=${() => setI(j)} title=${x.label}><${Media} path=${x.path} type=${x.type} poster=${x.main ? tags.poster : null} /><span>${x.label || 'File ' + (j + 1)}</span></button>`)}</div>`}
    <div class="row">
      ${cur && html`<button class="btn sm" onClick=${() => downloadMedia(cur.path, ad.base_name + (cur.main ? '' : ' - ' + (cur.label || 'extra'))).catch((e) => say('Download failed: ' + e.message))}>Download</button>`}
      <button class="btn sm" onClick=${copyName}>Copy name</button>
      <label class="btn sm ghost">${busy ? 'Adding…' : '+ Add file'}<input type="file" accept="image/*,video/*" hidden onChange=${(e) => { add(e.target.files[0]); e.target.value = ''; }} /></label>
      ${cur && !cur.main && html`<button class="btn sm ghost" onClick=${makeMain}>Make main</button><button class="btn sm ghost danger" onClick=${removeCur}>Remove</button>`}
    </div></div>`;
}

function AdDetail(ctx) {
  const { data, adId, close, setModal, setLightbox, reload, say } = ctx;
  const ad = data.ads.find((a) => a.id === adId);
  const [confirmDel, setConfirmDel] = useState(false);
  if (!ad) return null;
  const product = data.products.find((p) => p.id === ad.product_id) || ctx.product;
  const rules = R.rulesOf(product), econ = R.econOf(product);
  const tests = data.tests.filter((t) => t.ad_id === ad.id && !isDupTest(t)).sort(byCreated);
  const active = tests.find((t) => t.status === 'active');
  const hist = ad.history || {};
  const tags = ad.tags || {};
  const family = data.ads.filter((a) => a.id !== ad.id && (a.parent_id === ad.id || a.id === ad.parent_id || (ad.parent_id && a.parent_id === ad.parent_id)));
  const decisions = data.decisions.filter((d) => d.ad_id === ad.id).sort((a, b) => String(b.day).localeCompare(String(a.day)));
  const open = (type, props) => setModal({ type, props: { adId: ad.id, ...props } });
  const log = (kind, choice, reason) => be.insert('decisions', { product_id: ad.product_id, ad_id: ad.id, kind, choice, reason: reason || '' });
  const move = async (to, note, patch) => {
    const p2 = { stage: to, ...(patch || {}) };
    if (to === 'next' && ad.stage !== 'next') p2.tags = { ...((patch && patch.tags) || tags), queue: Date.now() };
    try { await be.update('ads', ad.id, p2); }
    catch (e) { say('Could not move: ' + e.message); await reload(); return; }
    try { await closeTestFor(ad, to, data); } catch (e) { console.warn('could not close test', e); }
    try { await log('move', `Moved to ${R.stageLabel(to)}`, note); } catch (e) { console.warn('decision log failed', e); }
    await reload(); say('Moved to ' + R.stageLabel(to));
  };
  const setTag = async (k, v, msg) => { await be.update('ads', ad.id, { tags: { ...tags, [k]: v } }); await reload(); say(msg); };
  const del = async () => { await be.remove('ads', ad.id); await reload(); close(); say('Deleted'); };

  const A = (label, fn, cls) => html`<button class=${'btn ' + (cls || '')} onClick=${fn}>${label}</button>`;
  const actions = [];
  switch (ad.stage) {
    case 'next': {
      const q = data.ads.filter((a) => a.stage === 'next' && a.product_id === ad.product_id).sort((a, b) => R.queueOf(a) - R.queueOf(b));
      const pos = q.findIndex((a) => a.id === ad.id);
      actions.push(A('It went live in Meta', () => open(LaunchForm), 'primary'));
      actions.push(A(tags.review ? `Check: ${tags.review.score}/100` : 'Pre-launch check', () => open(ReviewForm)));
      if (pos > 0) actions.push(A('Move to #1', async () => { await be.update('ads', ad.id, { tags: { ...tags, queue: R.queueOf(q[0]) - 1000 } }); await reload(); say('Now #1 in Up Next'); }));
      actions.push(A('Back to Ideas', () => move('ideas', 'Not ready yet'), 'ghost'));
      actions.push(A('Straight to Main (no test)', () => open(MainForm, { mode: 'start', emergency: true }), 'ghost'));
      break;
    }
    case 'ideas':
      actions.push(A('Ready: put in Up Next', () => move('next', 'Ready to launch'), 'primary'));
      actions.push(A(tags.review ? `Check: ${tags.review.score}/100` : 'Pre-launch check', () => open(ReviewForm)));
      actions.push(A('It went live in Meta', () => open(LaunchForm)));
      actions.push(A('Straight to Main (no test)', () => open(MainForm, { mode: 'start', emergency: true }), 'ghost'));
      break;
    case 'retest':
      actions.push(A('Queue for retest: Up Next', () => move('next', 'Queued for retest'), 'primary'));
      actions.push(A('Recycle with a fix', () => setModal({ type: AdForm, props: { mode: 'version', adId: ad.id, recycle: true } })));
      actions.push(A('It went live in Meta', () => open(LaunchForm)));
      break;
    case 'testing':
      if (!active) actions.push(A('Set start date and budget', () => open(LaunchForm), 'primary'));
      if (active) actions.push(A('Add Ads Manager file', () => setModal({ type: MetaFileModal, props: { back: ad.id } }), 'primary'));
      if (active) actions.push(A('Type results', () => open(CheckinForm, { testId: active.id })), A('Finalize', () => open(FinalizeForm, { testId: active.id })), A('Stop early', () => open(StopForm, { testId: active.id }), 'danger'));
      break;
    case 'bench':
      actions.push(A('Put in Main', () => open(MainForm, { mode: 'start' }), 'primary'));
      break;
    case 'main':
      if (active && active.stage === 2) actions.push(A('Record Main result', () => open(MainForm, { mode: 'record', testId: active.id }), 'primary'));
      actions.push(A(tags.fatiguing ? 'Not fatiguing' : 'Mark fatiguing', () => setTag('fatiguing', !tags.fatiguing, tags.fatiguing ? 'Marked running' : 'Marked fatiguing')));
      actions.push(A('Turned off: Exhausted', () => open(ExhaustForm), 'ghost'));
      break;
    case 'exhausted':
      actions.push(A('Revive to Bench', () => move('bench', 'Revived after rest', { tags: { ...tags, revivedOn: R.today(), fatiguing: false } }), 'primary'));
      break;
    case 'mid':
      actions.push(A('Recycle with a fix', () => setModal({ type: AdForm, props: { mode: 'version', adId: ad.id, recycle: true } }), 'primary'));
      actions.push(A('Retest as is: Up Next', () => move('next', 'Retest as is')));
      break;
    case 'failed':
      actions.push(A('Recycle with a fix', () => setModal({ type: AdForm, props: { mode: 'version', adId: ad.id, recycle: true } })));
      if (ad.setup_era === 'era1') actions.push(A('Move to Retest (Era 1 result)', () => move('retest', 'Era 1 result was not a fair test')));
      break;
    case 'seasonal':
      actions.push(A('Queue it: Up Next', () => move('next', 'Pulled from Seasonal')));
      break;
  }
  const era = R.ERAS[ad.setup_era];

  return html`<${Modal} wide title=${displayName(ad)} sub=${product.name + ' · ' + (ad.format || 'image')} onClose=${close}>
    <div class="detail">
      <div class="stack">
        <${MediaGallery} ad=${ad} ...${ctx} />
        <div class="row"><button class="btn sm" onClick=${() => setModal({ type: AdForm, props: { mode: 'edit', adId: ad.id } })}>Edit</button>
          <button class="btn sm" onClick=${() => setModal({ type: AdForm, props: { mode: 'version', adId: ad.id } })}>New version</button>
          <span class="spacer"></span>
          ${confirmDel ? html`<span class="small">Delete for good?</span><button class="btn sm danger" onClick=${del}>Delete</button><button class="btn sm ghost" onClick=${() => setConfirmDel(false)}>Keep</button>` : html`<button class="btn sm ghost danger" onClick=${() => setConfirmDel(true)}>Delete</button>`}</div>
        ${family.length > 0 && html`<div class="panel"><h2>Versions</h2>${family.map((f) => html`<button class="card" onClick=${() => setModal({ type: AdDetail, props: { adId: f.id } })}><${Media} path=${f.media_path} type=${f.media_type} /><span class="t"><span class="nm">${displayName(f)}</span><span class="ln">${R.stageLabel(f.stage)}</span></span></button>`)}</div>`}
      </div>
      <div class="stack">
        <div class="row">
          <span class="chip t-live">${R.stageLabel(ad.stage)}</span>
          ${ad.stage === 'main' && html`<span class=${'chip t-' + (tags.fatiguing ? 'mid' : 'pass')}>${tags.fatiguing ? 'Fatiguing' : 'Running'}</span>`}
          ${ad.stage === 'exhausted' && tags.offReason && html`<span class="chip t-muted">Off · ${tags.offReason}</span>`}
          ${ad.result && ['next', 'ideas', 'retest', 'mid', 'failed', 'bench'].includes(ad.stage) && !R.RESULTS[ad.result].main && html`<span class=${'chip t-' + toneOf(ad.result)}>${(R.RESULTS[ad.result] || {}).label || ad.result}</span>`}
          ${era && ad.setup_era !== 'era1' && html`<span class="chip t-muted" title=${era.note}>${era.short}</span>`}
          ${hist.oldPage && ad.setup_era !== 'era1' && html`<span class="chip t-mid">Old landing page</span>`}
          ${ad.launched_on && html`<span class="chip t-muted">Live ${ad.launched_on}</span>`}
        </div>
        ${ad.setup_era === 'era1' && html`<div class="status warn small">${R.ERAS.era1.note}</div>`}
        ${ad.stage === 'main' && html`<${HealthPanel} ad=${ad} data=${data} product=${product} />`}
        ${(() => { const rows = rowsForAd(ad, data.meta_days); if (!rows.length) return null; const hw = healthWindow(data); const t = sumRows(rows.filter((r) => hw && r.day >= hw.a && r.day <= hw.end)), all = sumRows(rows);
          return html`<div class="panel"><h2>From your Ads Manager files</h2><div class="metrics">
            <div class="metric"><small>Last 7 days${hw ? ' · ' + R.shortDate(hw.a) + '–' + R.shortDate(hw.end) : ''}</small><b>${R.money0(t.spend)}</b></div><div class="metric"><small>7d ROAS</small><b>${R.xroas(t.roas)}</b></div><div class="metric"><small>7d CPA</small><b>${R.money(t.cpa)}</b></div>
            <div class="metric"><small>All files</small><b>${R.money0(all.spend)}</b></div><div class="metric"><small>ROAS</small><b>${R.xroas(all.roas)}</b></div><div class="metric"><small>Buys</small><b>${Math.round(all.purchases)}</b></div></div>
            ${ad.stage !== 'testing' && html`<${ProfitLine} econ=${R.econOf(product)} m=${{ purchases: all.purchases, roas: all.roas, cpa: all.cpa, aov: all.purchases ? all.revenue / all.purchases : null }} product=${product} />`}</div>`; })()}
        <${TrendPanel} ad=${ad} data=${data} product=${product} />
        ${actions.length > 0 && html`<div class="row">${actions}</div>`}
        <div class="row"><label class="f" style="flex-direction:row;align-items:center;gap:8px">Move to
          <select class="inp" style="width:auto;min-height:36px" value=${ad.stage} onChange=${(e) => (e.target.value === 'testing' && !active ? open(LaunchForm) : move(e.target.value, 'Moved by hand'))}>
            ${[...R.STAGES, ...R.SHELVES].map((s) => html`<option value=${s.key}>${s.label}</option>`)}</select></label></div>
        ${(ad.headline || ad.primary_text || ad.offer || ad.notes) && html`<div class="panel">
          ${ad.offer && html`<div class="small"><span class="muted">Offer:</span> ${ad.offer}</div>`}
          ${ad.headline && html`<div class="small"><span class="muted">Headline:</span> ${ad.headline}</div>`}
          ${ad.primary_text && html`<div class="small" style="white-space:pre-wrap"><span class="muted">Primary text:</span> ${ad.primary_text}</div>`}
          ${ad.notes && html`<div class="small" style="white-space:pre-wrap"><span class="muted">Notes:</span> ${ad.notes}</div>`}</div>`}
        <${ConceptPanel} key=${ad.id + (ad.concept || '')} ad=${ad} ...${ctx} />
        ${hist.spend != null && html`<div class="panel"><h2>History</h2>
          <div class="metrics"><div class="metric"><small>Spend</small><b>${R.money0(hist.spend)}</b></div><div class="metric"><small>Buys</small><b>${hist.purchases}</b></div>
          <div class="metric"><small>CPA</small><b>${R.money(hist.cpa)}</b></div><div class="metric"><small>ROAS</small><b>${R.xroas(hist.roas)}</b></div>${hist.ran && html`<div class="metric"><small>Ran</small><b style="font-size:12.5px">${hist.ran}</b></div>`}</div>
          ${hist.ruleLabel && html`<div class="small muted">Rules on lifetime numbers: ${hist.ruleLabel}</div>`}
          ${hist.yourNote && html`<div class="status live">Your note: ${hist.yourNote}</div>`}
          ${hist.context && html`<div class="small muted">${hist.context}</div>`}</div>`}
        ${tests.map((t) => html`<${TestPanel} key=${t.id} ...${ctx} test=${t} rules=${rules} econ=${econ} />`)}
        ${decisions.length > 0 && html`<div class="panel"><h2>Decisions</h2><div class="list">${decisions.map((d) => html`<div class="li"><span class="mono small muted">${R.shortDate(d.day)}</span><span class="grow small"><b>${d.choice}</b>${d.reason ? ' · ' + d.reason : ''}</span></div>`)}</div></div>`}
      </div>
    </div>
  <//>`;
}

// Profit view: real numbers vs. break-even at this ad's own average order. Separate from the test rule.
function ProfitLine({ econ, m, product }) {
  if (!m || !m.purchases) return null;
  if (!econ.set) return html`<div class="status small">Break-even: costs not set for ${product ? product.name : 'this product'}. Add them in Rules.</div>`;
  const v = R.vsBreakEven(econ, m); if (!v || v.missing) return null;
  return html`<div class=${'status small ' + (v.band === 'above' ? 'good' : v.band === 'below' ? 'bad' : 'warn')}>
    <b>${v.label}</b> (${v.diff >= 0 ? '+' : ''}${v.diff.toFixed(1)}%) · ${R.money(v.perOrder >= 0 ? v.perOrder : -v.perOrder)} ${v.perOrder >= 0 ? 'profit' : 'loss'} per order after ads<br/>
    <span class="tiny">Break-even at its ${R.money(v.V)} average order: ${R.xroas(v.be.roas)} · ${R.money(v.be.cpa)} CPA. It's at ${R.xroas(m.roas)} · ${R.money(m.cpa)}.${v.estimated ? ' Estimated break-even based on assumed product mix.' : ''}</span></div>`;
}

function TestPanel({ data, test, rules, econ, setModal, reload, say }) {
  const cps = data.checkpoints.filter((c) => c.test_id === test.id).sort((a, b) => a.day - b.day);
  const ad = data.ads.find((a) => a.id === test.ad_id);
  const st = R.testStatus(test, cps, rules, econ.aov, test.stage === 1 ? liveFor(test, ad, data) : null);
  const m = st.m, dg = R.diagnose(m);
  const vb = m ? R.vsBreakEven(econ, m) : null;
  const hideOld = test.status !== 'active' && test.stage === 1 && !!(runsFor(test, ad, data) || {}).d7; // the Day-7 / full-run blocks replace it
  const c = test.conditions || {};
  return html`<div class=${'panel' + (test.status === 'active' ? ' accent' : '')}>
    <div class="row"><h2>${test.stage === 2 ? 'Stage 2 · Main' : 'Stage 1 test'}</h2><span class="spacer"></span>
      <span class="muted small">${test.start_date ? 'Day 1: ' + test.start_date : ''}${(test.conditions || {}).spendFrom ? ' (live from ' + test.conditions.spendFrom + ')' : ''}${test.budget ? ' · $' + test.budget + '/day' : ''}</span>
      <button class="link small" onClick=${() => setModal({ type: EditTestForm, props: { testId: test.id, adId: test.ad_id } })}>Edit</button></div>
    ${test.status === 'active' && test.stage === 1 && html`<div class=${'status ' + (st.final || st.onTrack ? 'good' : st.early ? 'bad' : st.behind || st.kept ? 'warn' : 'live')}>${st.text}
      ${st.early && html`<div class="row" style="margin-top:8px"><button class="btn sm" onClick=${async () => { await be.update('tests', test.id, { conditions: { ...(test.conditions || {}), keepRunning: R.today() } }); await be.insert('decisions', { product_id: test.product_id, ad_id: test.ad_id, test_id: test.id, kind: 'keep', day: R.today(), choice: 'Kept running after Pause? alert', reason: '' }); await reload(); say('Keeping it running'); }}>Keep running</button><button class="btn sm ghost" style="color:var(--fail)" onClick=${() => setModal({ type: StopForm, props: { testId: test.id } })}>Stop early</button></div>`}
      ${st.kept && html`<button class="link small" style="display:block;margin-top:6px" onClick=${async () => { const c = { ...(test.conditions || {}) }; delete c.keepRunning; await be.update('tests', test.id, { conditions: c }); await reload(); say('Alert back on'); }}>Undo: show the Pause? alert again</button>`}</div>`}
    ${test.status !== 'active' && test.result && html`<div class=${'status ' + (toneOf(test.result) === 'pass' ? 'good' : toneOf(test.result) === 'fail' ? 'bad' : 'warn')}><b>${(R.RESULTS[test.result] || {}).label || test.result}</b>${test.result_reason ? ' · ' + test.result_reason : ''}${test.override_reason ? html`<br/><span class="small">Your call: ${test.override_reason}</span>` : ''}</div>`}
    ${test.stage === 1 && (() => {
      const rr = runsFor(test, ad, data); if (!rr) return null;
      const done = test.status !== 'active';
      if (!done && !(rr.windowDone && rr.after && rr.after.spend)) return null;
      const lc = done && lateChange(test, rr), tr = trendAfter(rr);
      const ack = async () => { await be.update('tests', test.id, { conditions: { ...(test.conditions || {}), lateAck: lc.now } }); await reload(); say('Kept as filed'); };
      return html`<div class="stack" style="gap:8px">
        <${RunBlock} title="Day-7 result" sub=${`${R.shortDate(rr.from)} to ${R.shortDate(rr.end)}${rr.from < test.start_date ? ' (incl. partial launch day)' : ''}`} m=${rr.d7} />
        <${RunBlock} title=${done ? 'Full run' : 'Full run so far'} sub=${`${R.shortDate(rr.from)} to ${rr.lastDay ? R.shortDate(rr.lastDay) : '—'}${rr.off ? ' · turned off ' + R.shortDate(rr.off) : ''}`} m=${rr.full} />
        ${rr.after && rr.after.spend > 0 && html`<div class="small muted">After day 7: ${R.money(rr.after.spend)} spent, ${rr.after.purchases} buys, ${R.xroas(rr.after.roas)} ROAS.${tr ? ' ' + tr + '.' : ''}</div>`}
        ${done && slipped(test, rr) && html`<div class="status bad small"><b>${SLIP_TEXT}</b></div>`}
        ${lc && html`<div class="status warn small"><b>Newer files changed the Day-7 result.</b> When you finalized, your rules said ${R.RESULTS[lc.was].label}. With the latest numbers they say ${R.RESULTS[lc.now].label}. Your saved result hasn't been changed.
          <div class="row" style="margin-top:6px"><button class="btn sm" onClick=${() => setModal({ type: FinalizeForm, props: { testId: test.id } })}>Review and re-file</button><button class="btn sm ghost" onClick=${ack}>Keep as filed</button></div></div>`}
      </div>`; })()}
    ${test.stage === 1 && test.status === 'stopped' && !test.result && html`<div class="row"><span class="small muted grow">This test was closed without a result.</span><button class="btn sm" onClick=${() => setModal({ type: FinalizeForm, props: { testId: test.id } })}>Record result</button></div>`}
    ${m && !hideOld && html`<div class="metrics">
      <div class="metric"><small>Spend</small><b>${R.money(m.spend)}</b></div><div class="metric"><small>Buys</small><b>${m.purchases}</b></div>
      <div class=${'metric ' + (m.cpa != null ? (m.cpa <= rules.passACpa ? 'good' : 'bad') : '')}><small>CPA</small><b>${R.money(m.cpa)}</b></div>
      <div class=${'metric ' + (m.roas != null ? (vb && vb.band === 'above' ? 'good' : vb && vb.band === 'below' ? 'bad' : '') : '')}><small>ROAS${m.revenueEstimated ? '*' : ''}</small><b>${R.xroas(m.roas)}</b></div>
      <div class="metric"><small>Avg order</small><b>${R.money(m.aov)}</b></div><div class="metric"><small>CTR</small><b>${R.pct(m.ctr)}</b></div>
      ${m.hookRate != null && html`<div class="metric"><small>Hook rate</small><b>${R.pct(m.hookRate)}</b></div>`}</div>`}
    ${test.stage === 1 && html`<${ProfitLine} econ=${econ} m=${hideOld ? runsFor(test, ad, data).full : m} product=${data.products.find((p) => p.id === test.product_id)} />`}
    ${m && m.aov != null && m.aov < econ.aov * 0.9 && html`<div class="status warn">Orders on this ad average ${R.money(m.aov)}, under your ${R.money(econ.aov)} average. The offer may be pulling order size down.</div>`}
    ${dg && dg.steps.length > 0 && html`<div class="stack" style="gap:6px">${dg.steps.map((s) => html`<div class="meter"><span>${s.label}</span><span class="trk"><i style=${`width:${Math.min(100, s.value * (s.key === 'stop' ? 30 : s.key === 'cart' ? 3 : 1.6))}%;background:${s.ok ? 'var(--pass)' : 'var(--mid)'}`}></i></span><span class="mono" style="text-align:right">${s.value.toFixed(1)}%</span></div>`)}
      ${dg.advice && html`<span class="small" style="color:var(--mid)">${dg.advice}</span>`}</div>`}
    ${cps.length > 0 && html`<div class="tscroll"><table class="t"><thead><tr><th>Check-in</th><th>Spend</th><th>Buys</th><th>CPA</th><th>ROAS</th><th>CTR</th><th></th></tr></thead><tbody>
      ${cps.map((cp) => { const mm = R.metrics(cp, econ.aov); return html`<tr><td>Day ${cp.day}</td><td>${R.money(mm.spend)}</td><td>${mm.purchases}</td><td>${R.money(mm.cpa)}</td><td>${R.xroas(mm.roas)}</td><td>${R.pct(mm.ctr)}</td><td>${test.status === 'active' && html`<button class="link small" onClick=${() => setModal({ type: CheckinForm, props: { adId: test.ad_id, testId: test.id, day: cp.day } })}>Edit</button>`}</td></tr>`; })}
    </tbody></table></div>`}
    ${(c.landingPage || c.enhancements != null || c.method) && html`<div class="tiny muted">Conditions: ${[c.method, c.landingPage, c.enhancements ? 'creative enhancements ON' : c.enhancements === false ? 'enhancements off' : null, c.shopAds ? 'Shop ads ON' : null, c.productMismatch ? 'product in ad ≠ page' : null, c.emergency ? 'emergency, no test' : null].filter(Boolean).join(' · ')}</div>`}
  </div>`;
}

// ---------- forms ----------
const FMT_PREFIX = { image: 'IMG', video: 'VID', carousel: 'CAR' };
const buildName = (f) => [FMT_PREFIX[f.format] || 'IMG', f.short.trim() || '…', f.variant.trim(), 'V' + (f.v || 1)].filter(Boolean).join(' | ');
function AdForm(ctx) {
  const { data, product, mode, adId, recycle, close, reload, say, setModal } = ctx;
  const src = adId ? data.ads.find((a) => a.id === adId) : null;
  const bumpV = (n) => /V\d+\s*$/i.test(n) ? n.replace(/V(\d+)\s*$/i, (_, d) => 'V' + (+d + 1)) : n + ' | V2';
  const init = mode === 'new'
    ? { base_name: '', short: '', variant: '', v: 1, format: 'image', angle: '', offer: '$6 per shirt · 6 for $36 · Free shipping', headline: '', primary_text: '', notes: '', concept: '' }
    : { ...src, short: '', variant: '', base_name: mode === 'version' ? bumpV(src.base_name) : src.base_name, notes: mode === 'version' ? (recycle ? 'Recycled. The fix: ' : 'What changed: ') : src.notes };
  const [f, setF] = useState({ ...init, product_id: src ? src.product_id : product.id }); const [file, setFile] = useState(null); const [story, setStory] = useState(null); const [busy, setBusy] = useState(false); const [upNext, setUpNext] = useState(false);
  const hasStory = src && ((src.tags || {}).files || []).some((x) => x.label === '9:16');
  const [custom, setCustom] = useState(mode !== 'new');
  const [more, setMore] = useState(mode === 'edit' && !!(src.headline || src.primary_text || src.notes || src.concept));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const name = custom ? f.base_name : buildName(f);
  const cs = conceptStats(data, f.concept);
  const pickFile = (fl) => { setFile(fl); if (fl) { const fmt = /^video/.test(fl.type) ? 'video' : 'image'; setF((o) => ({ ...o, format: fmt, short: o.short || fl.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() })); } };
  const save = async () => {
    if (!name.trim() || name.includes('…')) { say('Give the ad a short name.'); return; }
    setBusy(true);
    try {
      const pidUse = src ? src.product_id : product.id;
      let media_path = mode === 'new' ? null : src.media_path, media_type = mode === 'new' ? null : src.media_type;
      const tags = mode === 'edit' ? { ...(src.tags || {}) } : {};
      if (file) {
        const stamp = `${pidUse}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        media_path = await be.upload(`${stamp}.${extOf(file)}`, file); media_type = file.type; delete tags.poster;
        if (/^video/.test(file.type)) { try { const pb = await videoPoster(file); tags.poster = await be.upload(`${stamp}.poster.jpg`, new File([pb], 'poster.jpg', { type: 'image/jpeg' })); } catch (e) { /* optional */ } }
      } else if (mode === 'version' && src.tags && src.tags.poster) tags.poster = src.tags.poster;
      if (mode === 'version' && !file && src.tags && src.tags.files) tags.files = src.tags.files;
      if (story) {
        const sp = await be.upload(`${pidUse}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-916.${extOf(story)}`, story);
        tags.files = [...(tags.files || []).filter((x) => x.label !== '9:16'), { path: sp, type: story.type, label: '9:16' }];
      }
      const row = { base_name: name.trim(), format: f.format, angle: f.angle || null, offer: f.offer, headline: f.headline, primary_text: f.primary_text, notes: f.notes, concept: f.concept || null, media_path, media_type, tags };
      if (mode === 'edit') { await be.update('ads', src.id, { ...row, product_id: f.product_id }); await reload(); close(); say(f.product_id !== src.product_id ? 'Moved to ' + ((data.products.find((p) => p.id === f.product_id) || {}).name || 'other product') : 'Saved'); return; }
      if (upNext) row.tags = { ...(row.tags || {}), queue: Date.now() };
      const ins = await be.insert('ads', { ...row, product_id: pidUse, stage: upNext ? 'next' : 'ideas', version: mode === 'version' ? (src.version || 1) + 1 : 1, parent_id: mode === 'version' ? src.id : null, history: {} });
      await reload(); say(upNext ? 'Added to Up Next' : mode === 'version' ? 'New version added to Ideas' : 'Added to Ideas');
      setModal({ type: AdDetail, props: { adId: ins.id } });
    } catch (e) { say('Could not save: ' + e.message); }
    setBusy(false);
  };
  return html`<${Modal} title=${mode === 'new' ? 'New ad' : mode === 'edit' ? 'Edit ad' : recycle ? 'Recycle with a fix' : 'New version'} sub=${mode === 'new' ? product.name : src.base_name} onClose=${close}>
    <div class="form">
      ${mode === 'edit' && html`<${Field} full label="Product (which product the ad shows)"><select value=${f.product_id} onChange=${set('product_id')}>${data.products.filter((p) => !p.archived).map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select><//>`}
      <${Field} label=${mode === 'edit' ? 'Replace 1:1 (feed, optional)' : '1:1 (feed) · main'}><input type="file" accept="image/*,video/*" onChange=${(e) => pickFile(e.target.files[0] || null)} /><//>
      <${Field} label=${hasStory ? 'Replace 9:16 (Stories / Reels)' : '9:16 (Stories / Reels) · optional'}><input type="file" accept="image/*,video/*" onChange=${(e) => setStory(e.target.files[0] || null)} /><//>
      ${!custom ? html`
        <${Field} label="Format"><select value=${f.format} onChange=${set('format')}><option value="image">Image</option><option value="video">Video</option><option value="carousel">Carousel</option></select><//>
        <${Field} label="What it says (short)"><input value=${f.short} onInput=${set('short')} placeholder="$6 Each" /><//>
        <${Field} label="Variant (optional)"><input value=${f.variant} onInput=${set('variant')} placeholder="Olive" /><//>
        <div class="namepreview full"><span class="tiny muted">Name in Ads Manager</span><b class="mono">${name}</b><button class="link small" onClick=${() => { setF({ ...f, base_name: name.replace('…', '') }); setCustom(true); }}>Edit name</button></div>`
      : html`<${Field} full label="Name, exactly as in Ads Manager (the launch date is added when it goes live)"><input value=${f.base_name} onInput=${set('base_name')} /><//>`}
      <div class="full pickpair"><div><div class="tiny muted" style="margin-bottom:6px">Angle: what it says</div><${AnglePicker} value=${f.angle} onPick=${(v) => setF({ ...f, angle: v })} product=${data.products.find((p) => p.id === f.product_id) || product} reload=${reload} say=${say} /></div>
      <div><div class="tiny muted" style="margin-bottom:6px">Concept: what it shows</div><${ConceptPicker} value=${f.concept || ''} onPick=${(v) => setF({ ...f, concept: v })} product=${data.products.find((p) => p.id === f.product_id) || product} data=${data} reload=${reload} say=${say} />
        ${cs && cs.counted > 0 && html`<div class="tiny muted" style="margin-top:6px">${f.concept}: ${cs.won} of ${cs.counted} worked since Era 1.</div>`}</div></div>
      <button type="button" class="link small full" style="text-align:left" onClick=${() => setMore(!more)}>${more ? '− Fewer details' : '+ More details (offer, headline, text, notes)'}</button>
      ${more && html`
        <${Field} full label="Offer"><input value=${f.offer || ''} onInput=${set('offer')} /><//>
        <${Field} full label="Headline"><input value=${f.headline || ''} onInput=${set('headline')} /><//>
        <${Field} full label="Primary text"><textarea value=${f.primary_text || ''} onInput=${set('primary_text')}></textarea><//>
        <${Field} full label="Notes"><textarea value=${f.notes || ''} onInput=${set('notes')}></textarea><//>`}
    </div>
    ${mode !== 'edit' && html`<label class="chk"><input type="checkbox" checked=${upNext} onChange=${(e) => setUpNext(e.target.checked)} /> Ready to launch: put it in Up Next (otherwise it goes to Ideas)</label>`}
    <div class="row"><button class="btn primary" disabled=${busy} onClick=${save}>${busy ? 'Saving…' : upNext ? 'Save to Up Next' : 'Save to Ideas'}</button><button class="btn ghost" onClick=${close}>Cancel</button></div>
  <//>`;
}

function LaunchForm(ctx) {
  const { data, adId, close, reload, say } = ctx;
  const ad = data.ads.find((a) => a.id === adId); const product = data.products.find((p) => p.id === ad.product_id);
  const rules = R.rulesOf(product);
  const live = data.tests.filter((t) => t.status === 'active' && t.stage === 1);
  const spendLive = live.reduce((s, t) => s + (+t.budget || 0), 0);
  const [f, setF] = useState({ date: R.today(), partial: false, budget: rules.stage1Budget, days: rules.plannedDays, method: R.TEST_METHODS[0], landingPage: 'Current page (Mar 2026+)', enhancements: false, shopAds: false });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const warns = [];
  if (live.length >= rules.slots) warns.push(`${live.length} Stage 1 tests are already live (your limit is ${rules.slots}).`);
  if (spendLive + (+f.budget || 0) > rules.testingCap) warns.push(`Testing spend would be $${spendLive + (+f.budget || 0)}/day, over your $${rules.testingCap} cap.`);
  if (rules.weekendLock && R.isWeekendLock()) warns.push('Weekend lock is on (Friday night to Sunday).');
  if (f.enhancements) warns.push('Creative enhancements ON: Meta will change your ad, so the result says less about your creative.');
  // Day 1 is the first full day. A partial day before it still counts toward spend and purchases.
  const spendFrom = f.partial ? R.addDays(f.date, -1) : f.date;
  const dayNow = Math.max(0, R.daysBetween(f.date, R.today()) + 1);
  const [saving, setSaving] = useState(false);
  const go = async () => {
    if (saving) return; setSaving(true);
    // One live test per ad: a new launch replaces any open one (also stops double-clicks making two).
    for (const t of data.tests.filter((x) => x.ad_id === ad.id && x.stage === 1 && x.status === 'active')) await be.update('tests', t.id, { status: 'stopped', result_reason: 'Replaced by a new launch.' });
    await be.insert('tests', { ad_id: ad.id, product_id: ad.product_id, stage: 1, start_date: f.date, planned_days: +f.days || rules.plannedDays, budget: +f.budget || null, status: 'active', conditions: { method: f.method, landingPage: f.landingPage, enhancements: f.enhancements, shopAds: f.shopAds, productMismatch: !!f.mismatch, ...(f.partial ? { spendFrom } : {}) } });
    await be.update('ads', ad.id, { stage: 'testing', launched_on: spendFrom, setup_era: R.eraOf(spendFrom), tags: { ...(ad.tags || {}), ready: false } });
    await be.insert('decisions', { product_id: ad.product_id, ad_id: ad.id, kind: 'launch', choice: `Launched at $${f.budget}/day`, day: spendFrom });
    await reload(); close(); say(dayNow > 1 ? `Test tracked. Today is day ${Math.min(dayNow, +f.days || rules.plannedDays)}.` : 'Test started. Name now shows the launch date.');
  };
  return html`<${Modal} title="It went live in Meta" sub=${ad.base_name} onClose=${close}>
    ${warns.length > 0 && html`<div class="banner"><ul style="margin:0;padding-left:18px">${warns.map((w) => html`<li>${w}</li>`)}</ul></div>`}
    <div class="form">
      <${Field} label="First full day of spend (day 1)"><input type="date" value=${f.date} onInput=${set('date')} /><//>
      <label class="chk full"><input type="checkbox" checked=${f.partial} onChange=${set('partial')} /> It went live partway through ${R.shortDate(R.addDays(f.date, -1))}. That day isn't one of the ${+f.days || rules.plannedDays} days, but its spend and sales are added to the totals.</label>
      <div class="status small full">Day 1 is ${R.shortDate(f.date)}. Day ${+f.days || rules.plannedDays} is ${R.shortDate(R.addDays(f.date, (+f.days || rules.plannedDays) - 1))}.${f.partial ? ` Plus the partial day ${R.shortDate(R.addDays(f.date, -1))}.` : ''}</div>
      ${dayNow > 1 && html`<div class="status live small full">Today is day ${dayNow} of this test.${f.partial ? ` Name date will be ${R.shortDate(spendFrom)}.` : ''}</div>`}
      <${Field} label="Budget ($/day)"><input inputmode="decimal" value=${f.budget} onInput=${set('budget')} /><//>
      <${Field} label="Test window (days)"><input inputmode="numeric" value=${f.days} onInput=${set('days')} /><//>
      <${Field} label="How you're testing it"><select value=${f.method} onChange=${set('method')}>${R.TEST_METHODS.filter((m) => !m.startsWith('Straight')).map((m) => html`<option>${m}</option>`)}</select><//>
      <${Field} full label="Landing page"><input value=${f.landingPage} onInput=${set('landingPage')} /><//>
      <label class="chk full"><input type="checkbox" checked=${f.enhancements} onChange=${set('enhancements')} /> Advantage+ creative enhancements on</label>
      <label class="chk full"><input type="checkbox" checked=${f.shopAds} onChange=${set('shopAds')} /> Shop ads on</label>
      <label class="chk full"><input type="checkbox" checked=${f.mismatch} onChange=${set('mismatch')} /> The ad shows a different product than the page it links to</label>
    </div>
    <div class="row"><button class="btn primary" disabled=${saving} onClick=${go}>Start test</button><button class="btn ghost" onClick=${close}>Cancel</button></div>
  <//>`;
}

function EditTestForm(ctx) {
  const { data, testId, close, reload, say } = ctx;
  const test = data.tests.find((t) => t.id === testId); const ad = data.ads.find((a) => a.id === test.ad_id);
  const c = test.conditions || {};
  const [f, setF] = useState({ mismatch: !!c.productMismatch, date: test.start_date || R.today(), partial: !!c.spendFrom, budget: test.budget ?? '', days: test.planned_days || 7, method: c.method || R.TEST_METHODS[0], landingPage: c.landingPage || '', enhancements: !!c.enhancements, shopAds: !!c.shopAds });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const spendFrom = f.partial ? R.addDays(f.date, -1) : f.date;
  const typed = data.checkpoints.filter((x) => x.test_id === test.id && x.source !== 'file');
  const save = async () => {
    const cond = { ...c, method: f.method, landingPage: f.landingPage, enhancements: f.enhancements, shopAds: f.shopAds, productMismatch: !!f.mismatch }; delete cond.spendFrom; if (f.partial) cond.spendFrom = spendFrom;
    await be.update('tests', test.id, { start_date: f.date, planned_days: +f.days || 7, budget: R.num(f.budget), conditions: cond });
    if (test.stage === 1 && ad) await be.update('ads', ad.id, { launched_on: spendFrom, setup_era: R.eraOf(spendFrom) });
    // Day numbers moved, so redo the check-ins that came from files.
    for (const cp of data.checkpoints.filter((x) => x.test_id === test.id && x.source === 'file')) await be.remove('checkpoints', cp.id);
    const fresh = await be.loadAll(); fresh.ads = fresh.ads.map(R.normalizeAd);
    const filled = await autoCheckins(fresh);
    await reload(); close(); say('Test updated' + (filled.length ? ' · check-ins refilled from your files' : ''));
  };
  return html`<${Modal} title="Edit test" sub=${ad ? ad.base_name : ''} onClose=${close}>
    <div class="form">
      <${Field} label="First full day of spend (day 1)"><input type="date" value=${f.date} onInput=${set('date')} /><//>
      <label class="chk full"><input type="checkbox" checked=${f.partial} onChange=${set('partial')} /> It went live partway through ${R.shortDate(R.addDays(f.date, -1))}. That day isn't one of the test days, but its spend and sales are added to the totals.</label>
      <${Field} label="Budget ($/day)"><input inputmode="decimal" value=${f.budget} onInput=${set('budget')} /><//>
      <${Field} label="Test window (days)"><input inputmode="numeric" value=${f.days} onInput=${set('days')} /><//>
      <${Field} label="How you're testing it"><select value=${f.method} onChange=${set('method')}>${R.TEST_METHODS.map((m) => html`<option>${m}</option>`)}</select><//>
      <${Field} full label="Landing page"><input value=${f.landingPage} onInput=${set('landingPage')} /><//>
      <label class="chk full"><input type="checkbox" checked=${f.enhancements} onChange=${set('enhancements')} /> Advantage+ creative enhancements on</label>
      <label class="chk full"><input type="checkbox" checked=${f.shopAds} onChange=${set('shopAds')} /> Shop ads on</label>
      <label class="chk full"><input type="checkbox" checked=${f.mismatch} onChange=${set('mismatch')} /> The ad shows a different product than the page it links to</label>
    </div>
    ${typed.length > 0 && html`<div class="banner small">You typed ${typed.length} check-in${typed.length > 1 ? 's' : ''} by hand. ${typed.length > 1 ? 'They stay' : 'It stays'} as is; edit ${typed.length > 1 ? 'them' : 'it'} if the day numbers changed.</div>`}
    <div class="row"><button class="btn primary" onClick=${save}>Save</button><button class="btn ghost" onClick=${close}>Cancel</button></div>
  <//>`;
}

function CheckinForm(ctx) {
  const { data, testId, day: editDay, close, reload, say } = ctx;
  const test = data.tests.find((t) => t.id === testId); const product = data.products.find((p) => p.id === test.product_id);
  const rules = R.rulesOf(product);
  const cps = data.checkpoints.filter((c) => c.test_id === test.id);
  const st = R.testStatus(test, cps, rules, R.econOf(product).aov);
  const existing = editDay != null ? cps.find((c) => c.day === editDay) : null;
  const d0 = existing ? existing.day : (st.due.length ? st.due[st.due.length - 1] : Math.max(1, Math.min(st.day, test.planned_days)));
  const fields = [['spend', 'Amount spent ($)'], ['purchases', 'Purchases'], ['revenue', 'Purchase value ($)'], ['impressions', 'Impressions'], ['link_clicks', 'Link clicks'], ['adds_to_cart', 'Adds to cart'], ['checkouts', 'Checkouts started'], ['frequency', 'Frequency'], ['hook_plays', '3-second video plays']];
  const [f, setF] = useState(() => { const o = { day: d0, notes: '', last3_purchases: '' }; fields.forEach(([k]) => { o[k] = existing && existing[k] != null ? existing[k] : ''; }); if (existing) { o.notes = existing.notes || ''; o.last3_purchases = existing.last3_purchases ?? ''; } return o; });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const isFinal = +f.day >= (test.planned_days || rules.plannedDays);
  const save = async () => {
    if (f.spend === '' || f.purchases === '') { say('Spend and purchases are needed.'); return; }
    const row = { test_id: test.id, day: +f.day, notes: f.notes, source: 'manual' };
    fields.forEach(([k]) => { row[k] = R.num(f[k]); });
    row.last3_purchases = isFinal ? R.num(f.last3_purchases) : null;
    const hit = cps.find((c) => c.day === +f.day);
    if (hit) await be.update('checkpoints', hit.id, row); else await be.insert('checkpoints', row);
    await reload(); close(); say(isFinal ? 'Saved. The test window is done: finalize it next.' : 'Saved. This is a status update, not a verdict.');
  };
  return html`<${Modal} title="Add results" sub="Numbers since the test started, straight from Ads Manager" onClose=${close}>
    ${data.missingTables && data.missingTables.includes('meta_days') ? html`<div class="banner small">To fill these from a file instead of typing, first run the setup file in Supabase (the banner on the main screen).</div>`
      : html`<div class="stack" style="gap:6px"><div class="small"><b>Skip the typing:</b> drop your Ads Manager export (Ads tab, Breakdown → Day, from the test's first day to yesterday). Day 3 and day 7 fill in on their own.</div><${MetaDrop} ...${ctx} compact /></div>
        <div class="tiny muted">Or type the numbers:</div>`}
    <div class="form">
      <${Field} label="Day"><input inputmode="numeric" value=${f.day} onInput=${set('day')} disabled=${!!existing} /><//>
      ${fields.map(([k, l]) => html`<${Field} label=${l}><input inputmode="decimal" value=${f[k]} onInput=${set(k)} /><//>`)}
      ${isFinal && html`<${Field} label=${`Purchases in the last ${rules.collapseDays} days`}><input inputmode="numeric" value=${f.last3_purchases} onInput=${set('last3_purchases')} /><//>`}
      <${Field} full label="Notes"><input value=${f.notes} onInput=${set('notes')} /><//>
    </div>
    <div class="row"><button class="btn primary" onClick=${save}>Save results</button><button class="btn ghost" onClick=${close}>Cancel</button></div>
  <//>`;
}

// Two numbers side by side: the standard window and the full run.
function RunBlock({ title, sub, m }) {
  if (!m) return null;
  return html`<div class="stack" style="gap:6px"><div class="small"><b>${title}</b> <span class="muted">${sub}</span></div>
    <div class="metrics"><div class="metric"><small>Spend</small><b>${R.money(m.spend)}</b></div><div class="metric"><small>Buys</small><b>${m.purchases}</b></div>
      <div class="metric"><small>Value</small><b>${R.money(m.revenue)}</b></div><div class="metric"><small>CPA</small><b>${R.money(m.cpa)}</b></div><div class="metric"><small>ROAS</small><b>${R.xroas(m.roas)}</b></div></div></div>`;
}
const SLIP_TEXT = 'Passed Stage 1, but performance slipped after Day 7. Review before advancing.';

function FinalizeForm(ctx) {
  const { data, testId, close, reload, say } = ctx;
  const test = data.tests.find((t) => t.id === testId); const product = data.products.find((p) => p.id === test.product_id);
  const ad = data.ads.find((a) => a.id === test.ad_id) || {};
  const rules = R.rulesOf(product), econ = R.econOf(product);
  const c0 = test.conditions || {};
  const [off, setOff] = useState(c0.stoppedOn || R.today());
  const cps = data.checkpoints.filter((c) => c.test_id === test.id).sort((a, b) => a.day - b.day);
  const last = cps[cps.length - 1];
  const runs = runsFor(test, ad, data, off);
  // The Day-7 result comes from your files when they cover the test (newest numbers, late sales included);
  // otherwise from the typed check-ins.
  const m = runs && runs.d7 ? runs.d7 : last ? R.metrics(last, econ.aov) : null;
  const c = runs && runs.d7 ? { result: runs.rule, evidence: runs.evidence } : R.classify(m, rules, last);
  const end = runs ? runs.end : test.start_date ? R.addDays(test.start_date, (test.planned_days || rules.plannedDays) - 1) : null;
  const early = end && off < end;
  const [pick, setPick] = useState(c.result || 'insufficient'); const [why, setWhy] = useState('');
  const events = data.events.filter((e) => (!e.product_id || e.product_id === test.product_id) && test.start_date && e.day >= test.start_date && e.day <= R.addDays(test.start_date, test.planned_days || 7));
  const trend = trendAfter(runs);
  const slip = runs && isPassRes(pick) && runs.after && runs.after.spend > 0 && runs.full.roas != null && runs.full.roas < rules.failRoas;
  const go = async () => {
    if (!c.result) { say('No numbers yet. Add your Ads Manager file first.'); return; }
    if (pick !== c.result && !why.trim()) { say('Add a reason when you change the result.'); return; }
    const strong = pick === 'strong_pass';
    const snap = (x) => (x ? { spend: round2(x.spend), purchases: x.purchases, revenue: round2(x.revenue) } : null);
    const conditions = { ...c0, stoppedOn: off, d7: { ...snap(m), end, rule: c.result }, full: runs ? { ...snap(runs.full), lastDay: runs.lastDay } : null };
    delete conditions.lateAck;
    await be.update('tests', test.id, { status: 'complete', result: pick, strong, result_reason: (c.evidence || []).join(' '), override_reason: pick !== c.result ? why : null, conditions });
    // Test result and lifecycle stay separate: an ad you already moved out of Testing stays where you put it.
    const move = ad.stage === 'testing';
    await be.update('ads', test.ad_id, { ...(move ? { stage: R.stageForResult(pick) } : {}), result: pick, tags: { ...(ad.tags || {}), retest: R.isRetestResult(pick), ready: false } });
    await be.insert('decisions', { product_id: test.product_id, ad_id: test.ad_id, test_id: test.id, kind: 'result', day: off, choice: `Filed as ${R.RESULTS[pick].label}`, reason: why });
    await reload(); close(); say(move ? 'Filed in ' + R.stageLabel(R.stageForResult(pick)) : 'Result saved');
  };
  return html`<${Modal} title="Finalize the test" sub=${ad.base_name} onClose=${close}>
    <div class="form">
      <${Field} label="Date you turned the ad off"><input type="date" value=${off} onInput=${(e) => setOff(e.target.value || R.today())} /><//>
    </div>
    ${early && html`<div class="banner">The 7 days aren't finished (day 7 is ${end}). Finalizing now is your call.</div>`}
    ${!m && html`<div class="banner">No numbers yet. Add your Ads Manager file first.</div>`}
    ${m && html`<div class="status ${toneOf(c.result) === 'pass' ? 'good' : toneOf(c.result) === 'fail' ? 'bad' : 'warn'}"><b>Day-7 result, your rules say: ${R.RESULTS[c.result].label}</b><ul style="margin:6px 0 0;padding-left:18px">${(c.evidence || []).map((x) => html`<li>${x}</li>`)}</ul><div class="small" style="margin-top:6px">${ad.stage === 'testing' ? html`Files into: <b>${R.stageLabel(R.stageForResult(pick))}</b>` : html`The ad stays in <b>${R.stageLabel(ad.stage)}</b>.`}</div></div>`}
    <${RunBlock} title="Day-7 result" sub=${runs ? `${R.shortDate(runs.from)} to ${R.shortDate(runs.end)}${runs.from < test.start_date ? ' (incl. partial launch day)' : ''}` : 'from your check-ins'} m=${m} />
    ${runs && html`<${RunBlock} title="Full run" sub=${`${R.shortDate(runs.from)} to ${runs.lastDay ? R.shortDate(runs.lastDay) + ' (last day with spend)' : '—'} · turned off ${R.shortDate(off)}`} m=${runs.full} />`}
    ${runs && runs.after && runs.after.spend > 0 && html`<div class="small muted">After day 7: ${R.money(runs.after.spend)} spent, ${runs.after.purchases} buys, ${R.xroas(runs.after.roas)} ROAS. ${trend || ''}.</div>`}
    ${slip && html`<div class="status bad small"><b>${SLIP_TEXT}</b></div>`}
    ${!runs && m && html`<div class="tiny muted">No Ads Manager file rows for this ad yet, so there's no full run. Add your file to see it.</div>`}
    <${ProfitLine} econ=${econ} m=${runs ? runs.full : m} product=${product} />
    ${events.length > 0 && html`<div class="banner">Changes logged during this test: ${events.map((e) => `${e.day} ${e.kind}`).join('; ')}. If they distorted it, file it as "Not a fair test".</div>`}
    <div class="form">
      <${Field} label="File it as"><select value=${pick} onChange=${(e) => setPick(e.target.value)}>${Object.entries(R.RESULTS).filter(([, v]) => !v.main).map(([k, v]) => html`<option value=${k}>${v.label}${k === c.result ? ' (your rules)' : ''}</option>`)}</select><//>
      <${Field} full label="Reason, if you change it"><input value=${why} onInput=${(e) => setWhy(e.target.value)} /><//>
    </div>
    <div class="row"><button class="btn primary" onClick=${go}>Save result</button><button class="btn ghost" onClick=${close}>Not yet</button></div>
  <//>`;
}

function StopForm(ctx) {
  const { data, testId, close, reload, say } = ctx;
  const test = data.tests.find((t) => t.id === testId);
  const ad = data.ads.find((a) => a.id === test.ad_id) || {};
  const [why, setWhy] = useState('early'); const [note, setNote] = useState(''); const [day, setDay] = useState(R.today());
  const dayN = test.start_date ? R.daysBetween(test.start_date, day) + 1 : null;
  const from = (test.conditions || {}).spendFrom || test.start_date;
  const rows = ad.id ? rowsForAd(ad, data.meta_days).filter((r) => r.day >= from && r.day <= day) : [];
  const t = rows.length ? sumRows(rows) : null;
  const go = async () => {
    const result = why === 'early' ? 'fail' : 'unfair';
    // Save the numbers up to the stop day as the last check-in, when your files cover it.
    if (t && dayN > 0) {
      const row = { test_id: test.id, day: dayN, spend: round2(t.spend), purchases: t.purchases, revenue: round2(t.revenue), impressions: t.impressions, link_clicks: t.link_clicks, adds_to_cart: t.adds_to_cart, checkouts: t.checkouts, frequency: round2(t.frequency), notes: 'Final numbers at stop', source: 'file' };
      const hit = data.checkpoints.find((c) => c.test_id === test.id && c.day === dayN);
      if (hit) await be.update('checkpoints', hit.id, row); else await be.insert('checkpoints', row);
    }
    const when = `on day ${dayN} (${day})`;
    await be.update('tests', test.id, { status: 'stopped', result, conditions: { ...(test.conditions || {}), stoppedOn: day }, result_reason: why === 'early' ? `Stopped by the early-stop rule ${when}.` : `Stopped ${when}: ` + (note || 'outside problem'), override_reason: note || null });
    await be.update('ads', test.ad_id, { stage: R.stageForResult(result), result, tags: { ...(ad.tags || {}), retest: R.isRetestResult(result), ready: false } });
    await be.insert('decisions', { product_id: test.product_id, ad_id: test.ad_id, test_id: test.id, kind: 'kill', day, choice: `Stopped early ${when}`, reason: note });
    await reload(); close(); say('Stopped and filed in ' + R.stageLabel(R.stageForResult(result)));
  };
  return html`<${Modal} title="Stop early" sub=${ad.base_name} onClose=${close}>
    <div class="form">
      <${Field} label="Date you turned it off"><input type="date" value=${day} onInput=${(e) => setDay(e.target.value)} /><//>
      <div class="status live small">${dayN ? `That's day ${dayN} of the test.` : ''}${t ? ` Up to then: ${R.money(t.spend)} spent, ${Math.round(t.purchases)} buys, ${R.xroas(t.roas)} ROAS.` : ' Add your Ads Manager file first to save the final numbers.'}</div>
      <${Field} full label="Why"><select value=${why} onChange=${(e) => setWhy(e.target.value)}><option value="early">Bad numbers (files as Fail)</option><option value="outside">Stock, site, tracking or Meta problem (files as Not a fair test)</option></select><//>
      <${Field} full label="Note"><input value=${note} onInput=${(e) => setNote(e.target.value)} /><//>
    </div>
    <div class="row"><button class="btn primary" onClick=${go}>Stop and file</button><button class="btn ghost" onClick=${close}>Cancel</button></div>
  <//>`;
}

function MainForm(ctx) {
  const { data, adId, mode, testId, emergency, close, reload, say } = ctx;
  const ad = data.ads.find((a) => a.id === adId); const product = data.products.find((p) => p.id === ad.product_id); const rules = R.rulesOf(product);
  const test = testId ? data.tests.find((t) => t.id === testId) : null;
  const [f, setF] = useState({ date: R.today(), base: '', after: '', verdict: 'held', dest: 'bench', note: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const start = async () => {
    if (emergency && !f.note.trim()) { say('Add a short reason for skipping the test.'); return; }
    await be.insert('tests', { ad_id: ad.id, product_id: ad.product_id, stage: 2, start_date: f.date, planned_days: rules.stage2Max, status: 'active', conditions: { baseRoas: R.num(f.base), method: emergency ? 'Straight to Main (no test)' : undefined, emergency: !!emergency } });
    const patch = { stage: 'main', tags: { ...(ad.tags || {}), ready: false, fatiguing: false, mainSince: f.date } };
    if (emergency || !ad.launched_on) { patch.launched_on = f.date; patch.setup_era = R.eraOf(f.date); }
    await be.update('ads', ad.id, patch);
    await be.insert('decisions', { product_id: ad.product_id, ad_id: ad.id, kind: 'move', day: f.date, choice: emergency ? 'Straight to Main without a test' : 'Put in Main (Stage 2)', reason: f.note || 'Budget unchanged' });
    await reload(); close(); say('In Main. Check back in ' + rules.stage2Min + ' to ' + rules.stage2Max + ' days.');
  };
  const record = async () => {
    const held = f.verdict === 'held';
    await be.update('tests', test.id, { status: 'complete', result: held ? 'held' : 'not_held', result_reason: `Main ROAS ${f.base || (test.conditions || {}).baseRoas || '?'}x before, ${f.after || '?'}x after.`, override_reason: f.note || null });
    if (!held) await be.update('ads', ad.id, { stage: f.dest, tags: { ...(ad.tags || {}), notHeld: true } });
    await be.insert('decisions', { product_id: ad.product_id, ad_id: ad.id, test_id: test.id, kind: 'result', choice: held ? 'Held in Main' : `Didn't hold in Main, moved to ${R.stageLabel(f.dest)}`, reason: f.note });
    await reload(); close(); say(held ? 'Held in Main' : 'Moved to ' + R.stageLabel(f.dest));
  };
  const days = test && test.start_date ? R.daysBetween(test.start_date, R.today()) : 0;
  const benchLeft = data.ads.filter((a) => a.product_id === ad.product_id && a.stage === 'bench' && a.id !== ad.id).length;
  return html`<${Modal} title=${mode === 'start' ? (emergency ? 'Straight to Main' : 'Put in Main') : 'Record the Main result'} sub=${ad.base_name} onClose=${close}>
    ${mode === 'start' ? html`
      ${emergency ? html`<div class="banner">This skips the test. It's logged as an emergency move, like Try-On in July, so you can see later how often it works.</div>`
        : html`<p class="small muted" style="margin:0">Add one new ad at a time and keep the Main budget the same. Judge it after ${rules.stage2Min} to ${rules.stage2Max} days. ${benchLeft < rules.benchTarget ? `After this, your Bench has ${benchLeft} (target ${rules.benchTarget}).` : ''}</p>`}
      <div class="form"><${Field} label="Date added to Main"><input type="date" value=${f.date} onInput=${set('date')} /><//><${Field} label="Main ROAS before (optional)"><input inputmode="decimal" value=${f.base} onInput=${set('base')} /><//>
      <${Field} full label=${emergency ? 'Why skip the test' : 'Note'}><input value=${f.note} onInput=${set('note')} /><//></div>
      <div class="row"><button class="btn primary" onClick=${start}>Put in Main</button><button class="btn ghost" onClick=${close}>Cancel</button></div>`
    : html`${days < rules.stage2Min && html`<div class="banner">Only ${days} days in Main. Your rule is ${rules.stage2Min} to ${rules.stage2Max}.</div>`}
      <div class="form"><${Field} label="Main ROAS before"><input inputmode="decimal" value=${f.base || ((test && test.conditions) || {}).baseRoas || ''} onInput=${set('base')} /><//>
      <${Field} label="Main ROAS since adding it"><input inputmode="decimal" value=${f.after} onInput=${set('after')} /><//>
      <${Field} label="Verdict"><select value=${f.verdict} onChange=${set('verdict')}><option value="held">Held in Main (keep it)</option><option value="not">Didn't hold</option></select><//>
      ${f.verdict !== 'held' && html`<${Field} label="Move it to"><select value=${f.dest} onChange=${set('dest')}><option value="bench">Bench (try again later)</option><option value="mid">Mid-Tier</option><option value="failed">Failed</option></select><//>`}
      <${Field} full label="Note"><input value=${f.note} onInput=${set('note')} /><//></div>
      <div class="row"><button class="btn primary" onClick=${record}>Save</button><button class="btn ghost" onClick=${close}>Cancel</button></div>`}
  <//>`;
}

function ExhaustForm(ctx) {
  const { data, adId, close, reload, say } = ctx;
  const ad = data.ads.find((a) => a.id === adId);
  const [f, setF] = useState({ date: R.today(), reason: 'fatigued', note: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const go = async () => {
    const s2 = data.tests.find((t) => t.ad_id === ad.id && t.status === 'active');
    if (s2) await be.update('tests', s2.id, { status: 'stopped', result_reason: 'Turned off: ' + f.reason });
    await be.update('ads', ad.id, { stage: 'exhausted', tags: { ...(ad.tags || {}), fatiguing: false, offReason: f.reason, offOn: f.date } });
    await be.insert('decisions', { product_id: ad.product_id, ad_id: ad.id, kind: 'kill', day: f.date, choice: 'Turned off in Main: ' + f.reason, reason: f.note });
    await reload(); close(); say('Moved to Exhausted');
  };
  const bench = data.ads.filter((a) => a.product_id === ad.product_id && a.stage === 'bench');
  return html`<${Modal} title="Turned off in Main" sub=${ad.base_name} onClose=${close}>
    <div class="form">
      <${Field} label="Date turned off"><input type="date" value=${f.date} onInput=${set('date')} /><//>
      <${Field} label="Why"><select value=${f.reason} onChange=${set('reason')}><option value="fatigued">Fatigued</option><option value="stopped converting">Stopped converting</option><option value="replaced">Replaced by a better ad</option><option value="other">Other</option></select><//>
      <${Field} full label="Note"><input value=${f.note} onInput=${set('note')} /><//>
    </div>
    <div class=${'status ' + (bench.length ? 'live' : 'warn')}>${bench.length ? `Bench has ${bench.length} ready: ${bench.slice(0, 3).map((a) => a.base_name).join(', ')}.` : 'Your Bench is empty. Nothing tested is ready to replace it.'}</div>
    <div class="row"><button class="btn primary" onClick=${go}>Move to Exhausted</button><button class="btn ghost" onClick=${close}>Cancel</button></div>
  <//>`;
}

function ProductForm({ data, close, reload, say }) {
  const [name, setName] = useState(''); const [kind, setKind] = useState('other');
  const crew = data.products.find((p) => p.kind === 'crew');
  const go = async () => { if (!name.trim()) return; await be.insert('products', { name: name.trim(), kind, sort: data.products.length + 1, rules: crew ? crew.rules || {} : {}, economics: {} }); await reload(); close(); say('Product added. Set its costs in Rules.'); };
  return html`<${Modal} title="Add product" onClose=${close}><div class="form">
    <${Field} label="Name"><input value=${name} onInput=${(e) => setName(e.target.value)} placeholder="Hoodie" /><//>
    <${Field} label="Style"><select value=${kind} onChange=${(e) => setKind(e.target.value)}><option value="crew">Crew neck</option><option value="vneck">V-neck</option><option value="long">Long sleeve</option><option value="thermal">Thermal</option><option value="tank">Tank top</option><option value="other">Other</option></select><//></div>
    <p class="small muted" style="margin:0">It starts with Crew Neck's rules. Change them in Rules.</p>
    <div class="row"><button class="btn primary" onClick=${go}>Add</button><button class="btn ghost" onClick=${close}>Cancel</button></div><//>`;
}

// ---------- today ----------
function Today(ctx) {
  const { data, products, setModal, setPid, setView } = ctx;
  const items = [];
  for (const t of data.tests.filter((x) => x.status === 'active')) {
    const ad = data.ads.find((a) => a.id === t.ad_id); const p = products.find((x) => x.id === t.product_id); if (!ad || !p) continue;
    const rules = R.rulesOf(p);
    if (t.stage === 2) { const d = R.daysBetween(t.start_date, R.today()); if (d >= rules.stage2Min) items.push({ tone: 'blue', title: `Judge in Main: ${ad.base_name}`, sub: `${d} days in Main · ${p.name}`, tag: 'TODAY', go: () => setModal({ type: MainForm, props: { adId: ad.id, mode: 'record', testId: t.id } }) }); continue; }
    const st = R.testStatus(t, data.checkpoints.filter((c) => c.test_id === t.id), rules, R.econOf(p).aov, liveFor(t, ad, data));
    if (st.early) items.push({ tone: 'red', title: `Pause? ${displayName(ad)}`, sub: st.text, tag: 'DECIDE', go: () => setModal({ type: AdDetail, props: { adId: ad.id } }) });
    if (st.final) items.push({ tone: 'blue', title: `Finalize: ${displayName(ad)}`, sub: `${p.name} · window complete`, tag: 'TODAY', go: () => setModal({ type: FinalizeForm, props: { testId: t.id } }) });
    else if (st.due.length) items.push({ tone: 'amber', title: `Day ${st.due[st.due.length - 1]} results: ${displayName(ad)}`, sub: `${p.name} · day ${st.day} of ${st.planned}`, tag: 'DUE', go: () => setModal({ type: CheckinForm, props: { testId: t.id } }) });
  }
  for (const t of data.tests.filter((x) => x.stage === 1 && x.status === 'complete')) {
    const ad = data.ads.find((a) => a.id === t.ad_id); if (!ad) continue;
    const rr = runsFor(t, ad, data), lc = lateChange(t, rr);
    if (lc) items.push({ tone: 'amber', title: `Check result: ${displayName(ad)}`, sub: `Newer files: your rules now say ${R.RESULTS[lc.now].label} (filed as ${R.RESULTS[t.result] ? R.RESULTS[t.result].label : t.result}).`, tag: 'REVIEW', go: () => setModal({ type: AdDetail, props: { adId: ad.id } }) });
  }
  for (const p of products) {
    const bh = benchHealth(data, p);
    if (bh.urgent) items.unshift({ tone: 'red', title: `${p.name}: Bench is ${bh.bench ? 'low' : 'empty'} and Main is fatiguing`, sub: `${bh.fatiguing.map((a) => a.base_name).join(', ')} fatiguing. ${bh.bench} of ${bh.target} tested backups ready. Test now so September doesn't repeat.`, tag: 'ACT', go: () => { setPid(p.id); setView('board'); } });
    else if (bh.low && bh.main) items.push({ tone: 'amber', title: `${p.name}: Bench under target`, sub: `${bh.bench} of ${bh.target} tested backups ready.`, tag: 'PLAN', go: () => { setPid(p.id); setView('board'); } });
  }
  for (const p of products) for (const ad of data.ads.filter((x) => x.product_id === p.id && x.stage === 'main')) {
    const h = mainHealth(ad, data, p); if (!h) continue;
    const t = healthText(h);
    if (h.money === 'below') items.unshift({ tone: 'red', title: `${displayName(ad)}: below break-even (last 7 days)`, sub: t.m, tag: 'CHECK', go: () => setModal({ type: AdDetail, props: { adId: ad.id } }) });
    if (h.creative === 'fatigue' && !(ad.tags || {}).fatiguing) items.push({ tone: 'amber', title: `${displayName(ad)}: possible fatigue`, sub: t.c, tag: 'CHECK', go: () => setModal({ type: AdDetail, props: { adId: ad.id } }) });
  }

  const lastMeta = data.meta_days.reduce((m, r) => (r.day > m ? r.day : m), '');
  if (!lastMeta || lastMeta < R.addDays(R.today(), -1)) items.push({ tone: 'blue', title: lastMeta ? `Add yesterday's Ads Manager file (last one: ${lastMeta})` : 'Add your first Ads Manager file', sub: 'Keeps check-ins, fatigue warnings and Stats up to date.', tag: 'DAILY', go: () => setView('stats') });
  const ready = data.ads.filter((a) => a.stage === 'next').sort((a, b) => R.queueOf(a) - R.queueOf(b));
  const live = testingCount(data);
  const rules0 = R.rulesOf(products[0]);
  const running = data.tests.filter((t) => t.status === 'active');
  return html`
    <div class="row"><div class="stack" style="gap:0"><span class="small" style="color:var(--accent2);letter-spacing:.16em;font-weight:600">${new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()}</span><h1 style="font-size:34px">Today</h1></div></div>
    <${MetaDrop} ...${ctx} />
    <section class="panel"><h2>Due</h2>
      ${items.length ? html`<div class="list">${items.map((it) => html`<button class="li" style="background:none;border-left:0;border-right:0;border-bottom:0;color:inherit;text-align:left;cursor:pointer;width:100%" onClick=${it.go}><span class=${'bar ' + it.tone}></span><span class="grow"><b>${it.title}</b><br/><span class="small muted">${it.sub}</span></span><span class="mono tiny" style="color:var(--accent2)">${it.tag}</span></button>`)}</div>`
        : html`<div class="empty">Nothing due. ${running.length ? `${running.length} test${running.length > 1 ? 's' : ''} running.` : 'No tests running.'}</div>`}
    </section>
    ${ready.length > 0 && live < rules0.slots && html`<section class="panel"><h2>Slot open</h2><div class="small">${rules0.slots - live} test slot${rules0.slots - live > 1 ? 's' : ''} free. Launch next from Up Next:</div>
      <div class="list">${ready.map((a) => html`<button class="li" style="background:none;border-left:0;border-right:0;border-bottom:0;color:inherit;text-align:left;cursor:pointer;width:100%" onClick=${() => setModal({ type: AdDetail, props: { adId: a.id } })}><${Media} path=${a.media_path} type=${a.media_type} poster=${a.tags && a.tags.poster} cls="" /><span class="grow small"><b>#${ready.indexOf(a) + 1} · ${a.base_name}</b><br/><span class="muted">${(products.find((p) => p.id === a.product_id) || {}).name}</span></span></button>`)}</div></section>`}
    <section class="panel"><h2>Running</h2>
      ${running.length ? html`<div class="list">${running.map((t) => { const ad = data.ads.find((a) => a.id === t.ad_id); return ad && html`<button class="li" style="background:none;border-left:0;border-right:0;border-bottom:0;color:inherit;text-align:left;cursor:pointer;width:100%" onClick=${() => setModal({ type: AdDetail, props: { adId: ad.id } })}><span class="bar blue"></span><span class="grow small"><b>${displayName(ad)}</b><br/><span class="muted">${t.stage === 2 ? 'Trial in Main' : 'Stage 1'} · ${R.testDay(t) < 1 ? 'partial day, day 1 tomorrow' : 'day ' + R.testDay(t)}</span></span></button>`; })}</div>` : html`<div class="empty">No live tests</div>`}
    </section>`;
}

// ---------- angles ----------
function adNumbers(ad, data) {
  const h = ad.history || {};
  let spend = +h.spend || 0, buys = +h.purchases || 0, rev = h.roas != null && h.spend ? h.roas * h.spend : 0;
  for (const t of data.tests.filter((x) => x.ad_id === ad.id)) {
    const c = data.checkpoints.filter((x) => x.test_id === t.id).sort((a, b) => b.day - a.day)[0];
    if (!c) continue;
    spend += +c.spend || 0; buys += +c.purchases || 0; rev += c.revenue != null ? +c.revenue : 0;
  }
  return { spend, buys, rev };
}
const BUCKETS = [
  ['worked', 'Worked', 'pass', (a) => a.stage === 'bench' || a.stage === 'main'],
  ['exhausted', 'Exhausted (worked, then fatigued)', 'muted', (a) => a.stage === 'exhausted'],
  ['mid', 'Mid-Tier', 'mid', (a) => a.stage === 'mid'],
  ['failed', 'Failed', 'fail', (a) => a.stage === 'failed'],
  ['seasonal', 'Seasonal', 'ins', (a) => a.stage === 'seasonal'],
  ['open', 'Up Next, Ideas or Retest', 'live', () => true],
];
function summarize(list, data, withEra1) {
  const counted = withEra1 ? list : list.filter((a) => a.setup_era !== 'era1');
  const b = {}; BUCKETS.forEach(([k]) => { b[k] = []; });
  list.forEach((a) => { const hit = BUCKETS.find(([, , , fn]) => fn(a)); b[hit[0]].push(a); });
  const cnt = {}; BUCKETS.forEach(([k, , , fn]) => { cnt[k] = counted.filter((a) => BUCKETS.find(([, , , f]) => f(a))[0] === k).length; });
  const tot = counted.reduce((s, a) => { const n = adNumbers(a, data); return { spend: s.spend + n.spend, buys: s.buys + n.buys, rev: s.rev + n.rev }; }, { spend: 0, buys: 0, rev: 0 });
  const judged = cnt.worked + cnt.exhausted + cnt.mid + cnt.failed;
  return { b, cnt, tot, roas: tot.spend ? tot.rev / tot.spend : null, cpa: tot.buys ? tot.spend / tot.buys : null, winRate: judged ? (cnt.worked + cnt.exhausted) / judged : null, judged, hidden: list.length - counted.length };
}

function QuickSet({ list, field, data, reload, say, product: ctxProduct }) {
  const opts = field === 'angle' ? allAngles(data, ctxProduct) : allConcepts(data, ctxProduct);
  const [custom, setCustom] = useState({});
  const setIt = async (ad, v) => { if (!v) return; await be.update('ads', ad.id, { [field]: v }); await reload(); say('Saved'); };
  return html`<section class="panel"><h2>Set the ${field} here</h2><p class="small muted" style="margin:0">Pick one per ad. It moves into that ${field} right away.</p>
    <div class="list">${list.map((ad) => html`<div class="li"><${Media} path=${ad.media_path} type=${ad.media_type} /><span class="grow small"><b>${ad.base_name}</b></span>
      ${custom[ad.id] != null ? html`<input class="inp" style="max-width:200px;min-height:34px" placeholder="New ${field}" value=${custom[ad.id]} onInput=${(e) => setCustom({ ...custom, [ad.id]: e.target.value })} onKeyDown=${(e) => e.key === 'Enter' && setIt(ad, e.target.value.trim())} onBlur=${(e) => setIt(ad, e.target.value.trim())} />`
        : html`<select class="inp" style="max-width:220px;min-height:34px" value="" onChange=${(e) => e.target.value === '__new' ? setCustom({ ...custom, [ad.id]: '' }) : setIt(ad, e.target.value)}><option value="">Choose…</option>${opts.map((o) => html`<option value=${o}>${o}</option>`)}<option value="__new">+ New ${field}…</option></select>`}</div>`)}</div></section>`;
}

function Angles(ctx) {
  const { data, product } = ctx;
  const [by, setBy] = useState('angle');
  const [sel, setSel] = useState(null);
  const [era1, setEra1] = useState(false);
  const ads = data.ads.filter((a) => a.product_id === product.id && a.stage !== 'retired');
  const keyOf = (a) => ((by === 'angle' ? a.angle : a.concept) || '').trim();
  const groups = {};
  ads.forEach((a) => { const k = keyOf(a) || '__none'; (groups[k] = groups[k] || []).push(a); });
  const rows = Object.entries(groups).map(([k, list]) => ({ k, label: k === '__none' ? 'Not set' : k, list, s: summarize(list, data, era1) }))
    .sort((x, y) => (x.k === '__none') - (y.k === '__none') || (y.s.cnt.worked + y.s.cnt.exhausted) - (x.s.cnt.worked + x.s.cnt.exhausted) || y.s.tot.spend - x.s.tot.spend);
  const what = by === 'angle' ? 'angle' : 'concept';
  const head = html`<div class="row"><h1 style="font-size:30px">${by === 'angle' ? 'Angles' : 'Concepts'} · ${product.name}</h1><span class="spacer"></span>
    <div class="seg" role="group" aria-label="Group by"><button class=${by === 'angle' ? 'on' : ''} onClick=${() => { setBy('angle'); setSel(null); }}>By angle</button><button class=${by === 'concept' ? 'on' : ''} onClick=${() => { setBy('concept'); setSel(null); }}>By concept</button></div></div>
    <div class="row small muted" style="margin-top:-6px"><span>${by === 'angle' ? 'Angle = the message ($6 per shirt, lifestyle, pack value).' : 'Concept = the creative itself (same footage or shot, different text).'}</span><span class="spacer"></span>
      <label class="chk" style="margin:0"><input type="checkbox" checked=${era1} onChange=${(e) => setEra1(e.target.checked)} /> Count Era 1 in totals</label></div>`;
  const cur = sel && rows.find((r) => r.k === sel);
  if (cur) {
    const s = cur.s;
    return html`${head}
      <div class="row"><button class="btn sm ghost" onClick=${() => setSel(null)}>← All ${what}s</button><h2 style="font-size:22px;margin:0">${cur.label}</h2></div>
      <section class="tiles">
        <div class="tile"><div class="k">Ads</div><div class="v">${cur.list.length}</div><div class="s">${s.judged} judged${s.hidden ? ` · ${s.hidden} Era 1 not counted` : ''}</div></div>
        <div class="tile"><div class="k">Worked</div><div class="v">${s.winRate != null ? Math.round(s.winRate * 100) + '%' : '—'}</div><div class="s">${s.cnt.worked + s.cnt.exhausted} of ${s.judged} (incl. exhausted)${s.hidden && !era1 ? ', Era 1 not counted' : ''}</div></div>
        <div class="tile"><div class="k">ROAS</div><div class="v">${R.xroas(s.roas)}</div><div class="s">${R.money(s.cpa)} CPA</div></div>
        <div class="tile"><div class="k">Spend</div><div class="v">${R.money0(s.tot.spend)}</div><div class="s">${Math.round(s.tot.buys)} purchases</div></div>
      </section>
      ${cur.k === '__none' && html`<${QuickSet} list=${cur.list} field=${by} ...${ctx} />`}
      ${BUCKETS.map(([k, label, tone]) => s.b[k].length > 0 && html`<section class="panel"><div class="row"><h2>${label}</h2><span class=${'chip t-' + tone}>${s.b[k].length}</span></div>
        <div class="shelf">${s.b[k].map((ad) => html`<${Card} key=${ad.id} ad=${ad} ...${ctx} />`)}</div></section>`)}`;
  }
  return html`${head}
    ${rows.length ? html`<div class="angles">${rows.map((r) => { const s = r.s; const total = BUCKETS.reduce((n, [k]) => n + s.b[k].length, 0);
      return html`<button class=${'angle' + (r.k === '__none' ? ' none' : '')} onClick=${() => setSel(r.k)}>
        <span class="row" style="gap:6px"><b>${r.label}</b><span class="spacer"></span><span class="mono small muted">${r.list.length} ad${r.list.length === 1 ? '' : 's'}</span></span>
        <span class="abar">${BUCKETS.map(([k, , tone]) => s.b[k].length > 0 && html`<i class=${'b-' + tone} style=${`flex:${s.b[k].length}`} title=${k}></i>`)}</span>
        <span class="small">${s.b.worked.length + s.b.exhausted.length} worked · ${s.b.mid.length} mid · ${s.b.failed.length} failed${s.b.open.length ? ` · ${s.b.open.length} untested` : ''}${s.b.seasonal.length ? ` · ${s.b.seasonal.length} seasonal` : ''}</span>
        <span class="mono small muted">${s.tot.spend ? `${R.xroas(s.roas)} · ${R.money0(s.tot.spend)} spent` : 'No spend counted'}${s.hidden ? ` · ${s.hidden} Era 1 not counted` : ''}</span>
      </button>`; })}</div>` : html`<div class="empty">No ads yet</div>`}`;
}

// ---------- pre-launch check ----------
const CHECKS = [
  { k: 'price', q: 'Does the headline lead with $6 per shirt, not the pack total?', w: 20, size: 'small', fix: 'Lead with "$6". "Only $6 Each" won; "6 TEES. $36." did 1.01x and "6 TEES. ONE DRAWER." 0.57x.' },
  { k: 'product', q: 'Are the shirts big and clear in the first frame?', w: 20, size: 'big', fix: 'Show the shirts stacked or laid flat, filling the frame. Your image winners all do this.' },
  { k: 'hook', q: 'Is a person wearing the shirt, or the shirts themselves, on screen in the first 2 seconds?', w: 20, size: 'big', only: 'video', fix: 'Open on someone wearing it (Try-On won). Opening on packaging failed (0.97x).' },
  { k: 'bg', q: 'Light or clean background?', w: 10, size: 'small', only: 'image', fix: 'Light backgrounds won most often. Dark can work (Dark Stack), but most dark ads did not hold.' },
  { k: 'onepack', q: 'Does it push one specific pack or color mix?', w: 15, size: 'big', bad: true, fix: 'Single-pack ads pull orders down (Navy + Olive averaged about $36 vs $47). Show the range and let the bundles work.' },
  { k: 'match', q: 'Does the product in the ad match the page it links to?', w: 15, size: 'big', fix: 'V-neck creatives sent to the Crew page never passed. Link to the product the ad shows.' },
  { k: 'short', q: 'Is the text on the creative short (one headline, a few words)?', w: 10, size: 'small', fix: 'Cut it to one short line. The long testimonial caption failed (1.07x).' },
  { k: 'enh', q: 'Will Advantage+ creative enhancements be off?', w: 10, size: 'small', fix: "Turn them off so the result is about your creative, not Meta's edits." },
];
function scoreReview(ad, answers, data) {
  const fmt = ad.format === 'video' ? 'video' : 'image';
  const list = CHECKS.filter((c) => !c.only || c.only === fmt);
  let got = 0, max = 0; const fixes = [];
  for (const c of list) {
    max += c.w; const a = answers[c.k];
    const good = a === 'unsure' ? 0.5 : a == null ? 0 : (c.bad ? a === 'no' : a === 'yes') ? 1 : 0;
    got += c.w * good;
    if (a != null && good < 1) fixes.push({ size: c.size, text: c.fix });
  }
  const cs = conceptStats(data, ad.concept);
  if (false) { max += 10; fixes.push({ size: 'big', text: `This concept has ${cs.fam.length} versions${cs.counted ? ` and ${cs.won} of ${cs.counted} worked since Era 1` : ''}. Change the hook, first frame or offer, not just the text.` }); }
  else if (ad.concept) { max += 10; got += 10; }
  const done = list.every((c) => answers[c.k] != null);
  const score = max ? Math.round(got / max * 100) : 0;
  const verdict = score >= 80 ? 'Ready to launch' : score >= 60 ? 'Small changes first' : 'Big changes needed';
  return { list, score, verdict, fixes, done };
}
function ReviewForm(ctx) {
  const { data, adId, close, reload, say } = ctx;
  const ad = data.ads.find((a) => a.id === adId);
  const prev = (ad.tags && ad.tags.review) || {};
  const [ans, setAns] = useState(prev.answers || {});
  const r = scoreReview(ad, ans, data);
  const save = async (markReady) => {
    const into = markReady && ad.stage !== 'next' && ad.stage !== 'testing';
    await be.update('ads', ad.id, { ...(into ? { stage: 'next' } : {}), tags: { ...(ad.tags || {}), review: { answers: ans, score: r.score, verdict: r.verdict, day: R.today() }, ...(into ? { queue: Date.now() } : {}) } });
    await reload(); close(); say(markReady ? 'Scored and put in Up Next' : 'Check saved');
  };
  const tone = r.score >= 80 ? 'good' : r.score >= 60 ? 'warn' : 'bad';
  return html`<${Modal} title="Pre-launch check" sub=${ad.base_name} onClose=${close}>
    <p class="small muted" style="margin:0">Scored against what has won and lost in your own ads. The AI review that looks at the image itself comes later.</p>
    <div class="stack" style="gap:8px">${r.list.map((c) => html`<div class="qrow"><span class="small">${c.q}</span>
      <span class="seg sm">${['yes', 'no', 'unsure'].map((v) => html`<button class=${ans[c.k] === v ? 'on' : ''} onClick=${() => setAns({ ...ans, [c.k]: v })}>${v === 'unsure' ? 'Not sure' : v[0].toUpperCase() + v.slice(1)}</button>`)}</span></div>`)}</div>
    <div class=${'status ' + tone}><b>${r.score}/100 · ${r.done ? r.verdict : 'Answer every question'}</b>
      ${r.fixes.length > 0 && html`${['big', 'small'].map((sz) => r.fixes.filter((f) => f.size === sz).length > 0 && html`<div class="small" style="margin-top:6px"><b>${sz === 'big' ? 'Big changes' : 'Small changes'}</b><ul style="margin:4px 0 0;padding-left:18px">${r.fixes.filter((f) => f.size === sz).map((f) => html`<li>${f.text}</li>`)}</ul></div>`)}`}</div>
    <div class="row"><button class="btn primary" disabled=${!r.done} onClick=${() => save(r.score >= 80)}>${r.score >= 80 && ad.stage !== 'next' ? 'Save and put in Up Next' : 'Save'}</button><button class="btn ghost" onClick=${close}>Cancel</button></div>
  <//>`;
}

// ---------- analyst: file drop, auto check-ins, fatigue, stats ----------
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// Fill day 3 / day 7 check-ins for live tests from the Ads Manager rows. Numbers you typed yourself are never overwritten.
async function autoCheckins(data) {
  const filled = [];
  for (const t of data.tests.filter((x) => x.status === 'active' && x.stage === 1 && x.start_date)) {
    const ad = data.ads.find((a) => a.id === t.ad_id); const p = data.products.find((x) => x.id === t.product_id);
    if (!ad || !p) continue;
    const rules = R.rulesOf(p); const planned = t.planned_days || rules.plannedDays;
    const rows = rowsForAd(ad, data.meta_days).filter((r) => r.day >= ((t.conditions || {}).spendFrom || t.start_date));
    if (!rows.length) continue;
    const maxDay = rows.map((r) => r.day).sort().pop();
    const want = [...new Set([...R.checkinDays(rules).map((d) => Math.min(d, planned)), planned])];
    for (const d of want) {
      const end = R.addDays(t.start_date, d - 1);
      if (maxDay < end || end >= R.today()) continue; // only once that day is fully over
      const existing = data.checkpoints.find((c) => c.test_id === t.id && c.day === d);
      if (existing && existing.source !== 'file') continue;
      const tot = sumRows(rows.filter((r) => r.day <= end));
      const from = R.addDays(end, -((rules.collapseDays || 3) - 1));
      const row = { test_id: t.id, day: d, spend: round2(tot.spend), purchases: tot.purchases, revenue: round2(tot.revenue), impressions: tot.impressions, link_clicks: tot.link_clicks,
        adds_to_cart: tot.adds_to_cart, checkouts: tot.checkouts, frequency: round2(tot.frequency), hook_plays: tot.hook_plays || null,
        last3_purchases: d >= planned ? sumRows(rows.filter((r) => r.day >= from && r.day <= end)).purchases : null, notes: 'From Ads Manager file', source: 'file' };
      if (existing) await be.update('checkpoints', existing.id, row); else await be.insert('checkpoints', row);
      filled.push(`${ad.base_name}: day ${d}`);
    }
  }
  return filled;
}

// Day by day for one ad: spend bars (bottom) and the 7-day ROAS line (top), on the same dates.
// Hover or tap a day for exact numbers. "Show each day" opens the same numbers as a table.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WKD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const longDate = (d, yr) => { const x = R.parseDay(d); return `${WKD[x.getDay()]} ${MON[x.getMonth()]} ${x.getDate()}${yr ? ', ' + x.getFullYear() : ''}`; };
function useWidth() {
  const ref = useRef(null); const [w, setW] = useState(640);
  useEffect(() => { const el = ref.current; if (!el) return; const ro = new ResizeObserver(() => setW(Math.max(260, el.clientWidth))); ro.observe(el); setW(Math.max(260, el.clientWidth)); return () => ro.disconnect(); }, []);
  return [ref, w];
}
function TrendPanel({ ad, data, product }) {
  const [hi, setHi] = useState(null); const [table, setTable] = useState(false);
  const [box, W] = useWidth();
  const rows = rowsForAd(ad, data.meta_days || []);
  const byDay = new Map(); rows.forEach((r) => { const t = byDay.get(r.day) || { spend: 0, revenue: 0, purchases: 0 }; t.spend += +r.spend || 0; t.revenue += +r.revenue || 0; t.purchases += +r.purchases || 0; byDay.set(r.day, t); });
  const spent = [...byDay.keys()].filter((d) => byDay.get(d).spend > 0).sort();
  if (spent.length < 3) return null;
  const y1 = R.addDays(R.today(), -1), last = spent[spent.length - 1] < y1 ? spent[spent.length - 1] : y1;
  const first = spent[0] > R.addDays(last, -44) ? spent[0] : R.addDays(last, -44);
  const n = R.daysBetween(first, last) + 1; if (n < 3) return null;
  const days = Array.from({ length: n }, (_, i) => { const d = R.addDays(first, i), t = byDay.get(d) || { spend: 0, revenue: 0, purchases: 0 };
    let sp = 0, rv = 0; for (let k = 0; k < 7; k++) { const u = byDay.get(R.addDays(d, -k)); if (u) { sp += u.spend; rv += u.revenue; } }
    return { d, ...t, roas: t.spend > 0 ? t.revenue / t.spend : null, roll: sp > 0 ? rv / sp : null }; });
  const econ = R.econOf(product), all = sumRows(rows);
  const be = econ.set ? R.beAt(econ, all.purchases ? all.revenue / all.purchases : econ.aov) : null;
  const showYear = first.slice(0, 4) !== R.today().slice(0, 4) || last.slice(0, 4) !== first.slice(0, 4);
  // geometry (real pixels, so text never stretches)
  const L = 44, Rt = 8, T1 = 10, H1 = 120, G = 18, H2 = 64, B = 22, H = T1 + H1 + G + H2 + B;
  const step = (W - L - Rt) / n, x = (i) => L + step * (i + 0.5);
  const rMax = Math.max(1, ...days.map((v) => v.roll || 0), be && be.roas ? be.roas : 0) * 1.15;
  const yR = (v) => T1 + H1 * (1 - Math.min(v, rMax) / rMax);
  const sMax = Math.max(1, ...days.map((v) => v.spend)) * 1.1;
  const top2 = T1 + H1 + G, yS = (v) => top2 + H2 * (1 - v / sMax);
  const bw = Math.max(2, Math.min(14, step * 0.6));
  const pts = days.map((v, i) => (v.roll == null ? null : `${x(i)},${yR(v.roll)}`)).filter(Boolean).join(' ');
  const lblEvery = Math.max(1, Math.ceil(n / Math.max(3, Math.floor((W - L) / 64))));
  const pick = (e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.floor((e.clientX - r.left - L) / step); setHi(i >= 0 && i < n ? i : null); };
  const h = hi != null ? days[hi] : null;
  const range = `${longDate(first, showYear)} to ${longDate(last, showYear)}`;
  return html`<div class="panel"><h2>Day by day</h2>
    <div class="tiny muted">${range}${showYear ? ' · this ad hasn\'t run recently' : ''}</div>
    <div class="chart" ref=${box}>
      <svg width=${W} height=${H} style=${`height:${H}px`} onPointerMove=${pick} onPointerDown=${pick} onPointerLeave=${() => setHi(null)} role="img" aria-label="7-day ROAS and daily spend">
        <text x=${L} y=${T1 - 1} class="ax">7-day ROAS</text>
        ${[0, rMax / 1.15].map((t) => html`<line x1=${L} x2=${W - Rt} y1=${yR(t)} y2=${yR(t)} class="grid" /><text x=${L - 6} y=${yR(t) + 4} class="ax" text-anchor="end">${t.toFixed(1)}x</text>`)}
        ${be && be.roas && html`<line x1=${L} x2=${W - Rt} y1=${yR(be.roas)} y2=${yR(be.roas)} class="ref" /><text x=${W - Rt} y=${yR(be.roas) - 4} class="ax" text-anchor="end">break-even ${R.xroas(be.roas)}</text>`}
        <polyline points=${pts} fill="none" stroke="#3D8BFF" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <text x=${L} y=${top2 - 5} class="ax">Spend each day</text>
        <line x1=${L} x2=${W - Rt} y1=${top2 + H2} y2=${top2 + H2} class="grid" />
        <text x=${L - 6} y=${top2 + 8} class="ax" text-anchor="end">${R.money0(sMax / 1.1)}</text>
        ${days.map((v, i) => v.spend > 0 && html`<rect x=${x(i) - bw / 2} y=${yS(v.spend)} width=${bw} height=${Math.max(1, top2 + H2 - yS(v.spend))} rx="2" fill="#C2669E" opacity=${hi == null || hi === i ? 1 : 0.55} />`)}
        ${days.map((v, i) => i % lblEvery === 0 && html`<text x=${x(i)} y=${H - 6} class="ax" text-anchor="middle">${R.shortDate(v.d)}</text>`)}
        ${hi != null && html`<line x1=${x(hi)} x2=${x(hi)} y1=${T1} y2=${top2 + H2} class="cross" />${h.roll != null && html`<circle cx=${x(hi)} cy=${yR(h.roll)} r="4" fill="#3D8BFF" stroke="var(--panel)" stroke-width="2" />`}`}
      </svg>
      ${h && html`<div class="tip" style=${`left:${Math.min(W - 90, Math.max(90, x(hi)))}px;top:${T1 + 8}px`}><b>${longDate(h.d, showYear)}</b>
        <div>Spent ${h.spend > 0 ? R.money(h.spend) : '$0 (not running)'}</div>
        ${h.spend > 0 && html`<div>${h.purchases} buy${h.purchases === 1 ? '' : 's'} · that day ${R.xroas(h.roas)}</div>`}
        <div><i style="background:#3D8BFF"></i>7-day ROAS ${R.xroas(h.roll)}</div></div>`}
    </div>
    <div class="tiny muted">Top: the last 7 days' ROAS, recalculated each day, which smooths out Meta's random good and bad days. Bottom: what the ad spent each day. Hover or tap a day for the exact numbers. Today's partial day isn't shown.</div>
    <button class="link small" style="align-self:flex-start" onClick=${() => setTable(!table)}>${table ? 'Hide days' : 'Show each day'}</button>
    ${table && html`<div class="tscroll"><table class="t"><thead><tr><th>Day</th><th>Spend</th><th>Buys</th><th>Value</th><th>ROAS</th><th>7-day ROAS</th></tr></thead><tbody>
      ${days.slice().reverse().map((v) => html`<tr><td>${longDate(v.d, showYear)}</td><td>${v.spend > 0 ? R.money(v.spend) : '—'}</td><td>${v.spend > 0 ? v.purchases : '—'}</td><td>${v.spend > 0 ? R.money(v.revenue) : '—'}</td><td>${v.spend > 0 ? R.xroas(v.roas) : '—'}</td><td>${R.xroas(v.roll)}</td></tr>`)}
    </tbody></table></div>`}
  </div>`;
}

// ---------- Main ad health ----------
// One set of 7-day windows used everywhere: the last 7 complete days your files cover (never today's partial day).
function healthWindow(data) {
  const last = (data.meta_days || []).reduce((m, r) => (r.day > m ? r.day : m), '');
  if (!last) return null;
  const y = R.addDays(R.today(), -1), end = last < y ? last : y;
  return { end, a: R.addDays(end, -6), pb: R.addDays(end, -13), pe: R.addDays(end, -7), r: R.addDays(end, -2) };
}
const linkCtr = (t) => (t && t.impressions && t.link_clicks ? t.link_clicks / t.impressions * 100 : null);
// Two separate checks: creative health (is the ad wearing out?) and money (is it above break-even?).
// Suggestions only: nothing is paused, moved or marked automatically.
function mainHealth(ad, data, product) {
  const w = healthWindow(data); if (!w) return null;
  const rules = R.rulesOf(product), econ = R.econOf(product);
  const rows = rowsForAd(ad, data.meta_days);
  const pick = (a, b) => sumRows(rows.filter((r) => r.day >= a && r.day <= b));
  const cur = pick(w.a, w.end), prev = pick(w.pb, w.pe), rec = pick(w.r, w.end);
  const c0 = linkCtr(prev), c1 = linkCtr(cur), c3 = linkCtr(rec);
  let creative = 'none', roasDown = null, cpaUp = null, ctrDown = null;
  if (cur.spend >= rules.fatigueMinSpend && prev.spend >= rules.fatigueMinSpend) {
    roasDown = prev.roas ? (1 - (cur.roas || 0) / prev.roas) * 100 : 0;
    cpaUp = prev.cpa && cur.cpa ? (cur.cpa / prev.cpa - 1) * 100 : prev.purchases && !cur.purchases ? 100 : 0;
    const decline = roasDown >= rules.fatigueRoasDown || cpaUp >= rules.fatigueCpaUp;
    ctrDown = c0 && c1 != null ? (1 - c1 / c0) * 100 : null;
    const ctrSig = ctrDown != null && ctrDown >= rules.fatigueCtrDown;
    // The last 3 days only confirm direction (still weaker than the week before), not a second percentage test.
    const persist = rec.spend > 0 && (prev.roas == null || (rec.roas || 0) < prev.roas) && (c3 == null || c0 == null || c3 < c0);
    creative = !decline ? 'healthy' : ctrSig && persist ? 'fatigue' : 'cooling';
  }
  let money = 'uncertain', v = null, be = null;
  if (econ.set && cur.spend > 0) {
    if (cur.purchases > 0) { v = R.vsBreakEven(econ, { purchases: cur.purchases, roas: cur.roas, cpa: cur.cpa, aov: cur.revenue / cur.purchases }); if (v && !v.missing) money = v.band; }
    else { be = R.beAt(econ, econ.aov); if (be && be.cpa && cur.spend >= 2 * be.cpa) money = 'below'; }
  }
  return { w, cur, prev, rec, c0, c1, creative, money, v, be, roasDown, cpaUp, ctrDown, limited: cur.purchases < 5, econSet: econ.set };
}
const CREATIVE = { healthy: ['Healthy', 'pass'], cooling: ['Cooling off', 'muted'], fatigue: ['Possible fatigue', 'mid'], none: ['Not enough data', 'muted'] };
const MONEY = { above: ['Above break-even', 'pass'], near: ['Near break-even', 'mid'], below: ['Below break-even', 'fail'], uncertain: ['Economics uncertain', 'muted'] };
function healthText(h) {
  const d = `ROAS ${R.xroas(h.prev.roas)} → ${R.xroas(h.cur.roas)}, CPA ${R.money(h.prev.cpa)} → ${R.money(h.cur.cpa)}`;
  const ctr = h.c0 != null && h.c1 != null ? `, link CTR ${h.c0.toFixed(2)}% → ${h.c1.toFixed(2)}%` : '';
  const c = h.creative === 'none' ? `Needs at least $50 spend in each of the two weeks to judge.`
    : h.creative === 'healthy' ? `No meaningful decline (${d}${ctr}).`
    : h.creative === 'cooling' ? `Recent CPA up and ROAS down (${d}${ctr}); monitor. Not enough evidence of creative fatigue.`
    : `${d}${ctr}, and the last 3 days are still weaker. Your call whether to mark it fatiguing.`;
  const m = !h.econSet ? 'Costs not set for this product.'
    : h.v && !h.v.missing ? `${R.xroas(h.cur.roas)} vs ${R.xroas(h.v.be.roas)} break-even at its ${R.money(h.v.V)} average order (estimate).`
    : h.money === 'below' ? `${R.money(h.cur.spend)} spent with no purchases.` : 'Too little spend to tell.';
  return { c: c + (h.limited && h.creative !== 'none' ? ' Limited evidence: fewer than 5 purchases in the last 7 days.' : ''), m };
}
// Real frequency from whole-period exports (no daily breakdown). Only compared across equal-length periods.
function freqCheckpoints(ad) {
  const list = ((ad.tags || {}).freq || []).slice().sort((a, b) => String(b.to).localeCompare(String(a.to)));
  const byLen = new Map();
  for (const f of list) { const n = R.daysBetween(f.from, f.to) + 1; if (!byLen.has(n)) byLen.set(n, []); if (byLen.get(n).length < 2) byLen.get(n).push(f); }
  return [...byLen.entries()].sort((a, b) => a[0] - b[0]);
}
function HealthPanel({ ad, data, product }) {
  const h = mainHealth(ad, data, product); const fq = freqCheckpoints(ad);
  if (!h && !fq.length) return null;
  const t = h && healthText(h);
  return html`<div class="panel"><h2>Health · last 7 days</h2>
    ${h && html`<div class="tiny muted">${R.shortDate(h.w.a)} to ${R.shortDate(h.w.end)}, compared with ${R.shortDate(h.w.pb)} to ${R.shortDate(h.w.pe)}</div>
    <div class="stack" style="gap:6px">
      <div class="small"><span class=${'chip t-' + CREATIVE[h.creative][1]}>Creative: ${CREATIVE[h.creative][0]}</span> ${t.c}</div>
      <div class="small"><span class=${'chip t-' + MONEY[h.money][1]}>${MONEY[h.money][0]}</span> ${t.m}</div></div>`}
    ${fq.length > 0 && html`<div class="small"><b>Real frequency</b> <span class="muted">(from your whole-period exports)</span>
      ${fq.map(([n, l]) => html`<div class="tiny">${n}-day ${R.shortDate(l[0].from)} to ${R.shortDate(l[0].to)}: <b>${l[0].frequency.toFixed(2)}</b>${l[1] ? ` · previous ${n}-day (${R.shortDate(l[1].from)} to ${R.shortDate(l[1].to)}): ${l[1].frequency.toFixed(2)}` : ''}</div>`)}
      <div class="tiny muted">Context only. Frequency never decides fatigue on its own.</div></div>`}
  </div>`;
}

function MetaFileModal(ctx) {
  return html`<${Modal} title="Add Ads Manager file" sub="One file fills every test, every Main ad and Stats" onClose=${ctx.close}><${MetaDrop} ...${ctx} /><//>`;
}
function MetaDrop({ data, reload, say, compact }) {
  const [st, setSt] = useState(null);
  const last = data.meta_days.reduce((m, r) => (r.day > m ? r.day : m), '');
  const go = async (file) => {
    if (!file) return;
    setSt({ msg: 'Reading ' + file.name + '…' });
    try {
      const f = await readMetaFile(file);
      if (f.kind === 'freq') {
        // Whole-period export: save real frequency on each matching ad. No spend or sales are added.
        const byName = new Map(); f.periods.forEach((x) => { const k = normName(x.ad_name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(x); });
        let n = 0;
        for (const ad of data.ads) {
          const list = byName.get(normName(ad.base_name)); if (!list) continue;
          const keep = new Map(((ad.tags || {}).freq || []).map((x) => [x.from + '|' + x.to + '|' + x.adset, x]));
          list.forEach((x) => keep.set(x.from + '|' + x.to + '|' + x.adset, { from: x.from, to: x.to, adset: x.adset, reach: x.reach, impressions: x.impressions, frequency: x.frequency }));
          const freq = [...keep.values()].sort((a, b) => String(b.to).localeCompare(String(a.to))).slice(0, 24);
          await be.update('ads', ad.id, { tags: { ...(ad.tags || {}), freq } }); n++;
        }
        const pr = [...new Set(f.periods.map((x) => `${x.from} to ${x.to}`))];
        await reload();
        // Most of the time this is a daily export missing its Day breakdown, so say that loudly.
        setSt({ warn: true, msg: `This file has no daily breakdown (one row per ad for ${pr.slice(0, 2).join(', ')}${pr.length > 2 ? '…' : ''}), so it can't update spend, sales or your tests. To update them, export again with Breakdown → By time → Day. It was saved as a frequency checkpoint only, for ${n} ad${n === 1 ? '' : 's'}.` });
        say('No daily breakdown: numbers not updated'); return;
      }
      setSt({ msg: `Saving ${f.rows.length.toLocaleString()} rows…` });
      await be.upsert('meta_days', f.rows.map((r) => ({ ...r, imported_at: new Date().toISOString() })), (d, n) => setSt({ msg: `Saving ${d.toLocaleString()} of ${n.toLocaleString()} rows…` }));
      try { await be.cleanMetaDays(); } catch (e) { /* optional */ }
      const fresh = await be.loadAll(); fresh.ads = fresh.ads.map(R.normalizeAd);
      const filled = await autoCheckins(fresh);
      const known = new Set(fresh.ads.map((a) => normName(a.base_name)));
      const unmatched = [...new Set(f.rows.filter((r) => r.spend > 0 && !known.has(normName(r.ad_name))).map((r) => r.ad_name))];
      await reload();
      setSt({ ok: true, msg: `Added ${f.days.length === 1 ? f.days[0] : f.days[0] + ' to ' + f.days[f.days.length - 1]}: ${f.rows.length} ad rows, ${R.money0(f.spend)} spend.`
        + (filled.length ? ` Filled check-ins: ${filled.join(', ')}.` : '') + (f.ranged ? ` Skipped ${f.ranged} rows that covered several days.` : '') + (f.empty ? ` Skipped ${f.empty.toLocaleString()} rows for ads that didn't run.` : '') + (f.attribution && f.attribution.length ? ` Attribution in this file: ${f.attribution.join(', ')}.` : '') + (f.notBuys && f.notBuys.length ? ` ${f.notBuys.length} ad${f.notBuys.length > 1 ? 's' : ''} optimize for something other than purchases, so their buys show as 0.` : ''), unmatched });
      say('Ads Manager file added');
    } catch (e) { setSt({ err: true, msg: e.message }); }
  };
  return html`<div class=${'drop' + (compact ? ' compact' : '')}>
    <label class="btn primary"><input type="file" accept=".csv,.xlsx,.xls" hidden onChange=${(e) => { go(e.target.files[0]); e.target.value = ''; }} />Add Ads Manager file</label>
    <span class="small muted">${last ? `Meta numbers through ${last}.` : 'No Meta numbers yet.'} Export the Ads tab for yesterday (or with Breakdown → Day), CSV or Excel.</span>
    ${st && html`<div class=${'status small ' + (st.err ? 'bad' : st.warn ? 'warn' : st.ok ? 'good' : 'live')}>${st.msg}
      ${st.unmatched && st.unmatched.length > 0 && html`<div class="tiny muted" style="margin-top:4px">Not in Ad Lab yet (counted in totals): ${st.unmatched.slice(0, 6).join(' · ')}${st.unmatched.length > 6 ? ` +${st.unmatched.length - 6} more` : ''}</div>`}</div>`}
  </div>`;
}

function ShopSync({ data, reload, say }) {
  const [st, setSt] = useState(null);
  const last = data.shop_days.reduce((m, r) => (String(r.synced_at) > m ? String(r.synced_at) : m), '');
  const go = async () => {
    setSt({ msg: 'Pulling orders from Shopify…' });
    try { const r = await be.syncShopify(); await reload(); setSt({ ok: true, msg: `Synced ${r.orders} orders over ${r.days} days.` }); say('Shopify synced'); }
    catch (e) { setSt({ err: true, msg: e.message }); }
  };
  return html`<div class="drop compact">
    <button class="btn" onClick=${go}>Sync Shopify</button>
    <span class="small muted">${last ? 'Last synced ' + new Date(last).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '. Syncs on its own when you open the app.' : 'Not connected yet.'}</span>
    ${st && html`<div class=${'status small ' + (st.err ? 'bad' : st.warn ? 'warn' : st.ok ? 'good' : 'live')}>${st.msg}</div>`}
  </div>`;
}

// Line chart: one money axis, hover crosshair + tooltip.
function LineChart({ labels, series, fmt, refLine, height = 190, cap }) {
  const [hi, setHi] = useState(null);
  const W = 720, H = height, L = 48, Rt = 10, T = 12, B = 24;
  const vals = series.flatMap((s) => s.values.filter((v) => v != null));
  if (refLine) vals.push(refLine.value);
  // cap: an upper limit for the scale, so one freak day doesn't squash everything. Points above it sit on the top edge.
  const max = Math.max(1e-9, cap != null ? Math.min(cap, Math.max(...vals)) : Math.max(...vals)) * 1.1;
  const x = (i) => L + (labels.length <= 1 ? 0 : i * (W - L - Rt) / (labels.length - 1));
  const y = (v) => T + (H - T - B) * (1 - Math.min(v, max) / max);
  const ticks = [0, 0.5, 1].map((f) => max / 1.1 * f);
  const step = Math.max(1, Math.ceil(labels.length / 7));
  const move = (e) => { const r = e.currentTarget.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * W; const i = Math.round((px - L) / ((W - L - Rt) / Math.max(1, labels.length - 1))); setHi(Math.max(0, Math.min(labels.length - 1, i))); };
  return html`<div class="chart">
    <svg viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove=${move} onMouseLeave=${() => setHi(null)} role="img">
      ${ticks.map((t) => html`<line x1=${L} x2=${W - Rt} y1=${y(t)} y2=${y(t)} class="grid" /><text x=${L - 6} y=${y(t) + 4} class="ax" text-anchor="end">${fmt(t, true)}</text>`)}
      ${labels.map((l, i) => i % step === 0 && html`<text x=${x(i)} y=${H - 6} class="ax" text-anchor="middle">${R.shortDate(l)}</text>`)}
      ${refLine && html`<line x1=${L} x2=${W - Rt} y1=${y(refLine.value)} y2=${y(refLine.value)} class="ref" /><text x=${W - Rt} y=${y(refLine.value) - 5} class="ax" text-anchor="end">${refLine.label}</text>`}
      ${series.filter((s) => s.dots).map((s) => s.values.map((v, i) => v != null && html`<circle cx=${x(i)} cy=${y(v)} r="4" fill=${s.color} fill-opacity="0.6" stroke="var(--panel)" stroke-width="2" vector-effect="non-scaling-stroke" />`))}
      ${series.filter((s) => !s.dots).map((s) => { const pts = s.values.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' '); return html`<polyline points=${pts} fill="none" stroke=${s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />`; })}
      ${hi != null && html`<line x1=${x(hi)} x2=${x(hi)} y1=${T} y2=${H - B} class="cross" />${series.map((s) => s.values[hi] != null && html`<circle cx=${x(hi)} cy=${y(s.values[hi])} r="4" fill=${s.color} stroke="var(--panel)" stroke-width="2" vector-effect="non-scaling-stroke" />`)}`}
    </svg>
    ${series.length > 1 && html`<div class="legend">${series.map((s) => html`<span><i style=${'background:' + s.color + (s.dots ? ';opacity:.6;border-radius:50%;width:9px;height:9px' : '')}></i>${s.name}</span>`)}</div>`}
    ${hi != null && html`<div class="tip" style=${`left:${Math.min(80, Math.max(8, x(hi) / W * 100))}%`}><b>${labels[hi]}</b>${series.map((s) => html`<div><i style=${'background:' + s.color}></i>${s.name}: ${s.values[hi] == null ? '—' : fmt(s.values[hi])}</div>`)}</div>`}
  </div>`;
}

const RANGES = [['7', 'Last 7 days'], ['14', '14 days'], ['30', '30 days'], ['90', '90 days'], ['mtd', 'This month']];
function rangeDays(key) {
  const end = R.today();
  if (key === 'mtd') { const start = end.slice(0, 8) + '01'; return { start, end, n: R.daysBetween(start, end) + 1 }; }
  const n = +key; return { start: R.addDays(end, -(n - 1)), end, n };
}
function periodTotals(data, start, end, econ) {
  const shop = data.shop_days.filter((d) => d.day >= start && d.day <= end);
  const meta = data.meta_days.filter((d) => d.day >= start && d.day <= end);
  const revenue = shop.reduce((s, d) => s + (+d.gross || 0) - (+d.refunds || 0), 0);
  const orders = shop.reduce((s, d) => s + (+d.orders || 0), 0), units = shop.reduce((s, d) => s + (+d.units || 0), 0);
  const m = sumRows(meta);
  // Store-wide: product cost from the store's cost % (or Crew's ratio until it's entered), plus per-order costs.
  const st = R.storeEcon(), sb = R.storeBE(econ);
  const perOrder = (R.num(st.ship) || 0) + (R.num(st.pack) || 0) + (R.num(st.feeFixed) || 0) + (R.num(st.other) || 0);
  const profit = shop.length && !sb.missing ? revenue * (1 - sb.pct / 100 - (R.num(st.feePct) || 0) / 100) - orders * perOrder - m.spend : null;
  return { revenue, orders, units, spend: m.spend, metaRev: m.revenue, metaBuys: m.purchases, mer: m.spend ? revenue / m.spend : null, roas: m.roas,
    aov: orders ? revenue / orders : null, cpa: orders && m.spend ? m.spend / orders : null, profit, hasShop: shop.length > 0, hasMeta: meta.length > 0 };
}
function Delta({ now, prev, good = 'up' }) {
  if (now == null || prev == null || !prev) return null;
  const d = (now / prev - 1) * 100; if (!isFinite(d)) return null;
  const better = good === 'up' ? d >= 0 : d <= 0;
  return html`<span class=${'delta ' + (good === 'flat' || Math.abs(d) < 1 ? '' : better ? 'up' : 'down')}>${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}%</span>`;
}

function Stats(ctx) {
  const { data, product, setModal } = ctx;
  const [rk, setRk] = useState(() => { try { return localStorage.getItem('adlab-range') || '7'; } catch (e) { return '7'; } });
  const [tab, setTab] = useState('ads');
  const [all, setAll] = useState(false);
  useEffect(() => { try { localStorage.setItem('adlab-range', rk); } catch (e) {} }, [rk]);
  const crewE = R.econOf(data.products.find((p) => p.kind === 'crew'));
  const econ = crewE, bev = R.storeBE(crewE);
  const { start, end, n } = rangeDays(rk);
  const pStart = R.addDays(start, -n), pEnd = R.addDays(start, -1);
  const cur = periodTotals(data, start, end, econ), prev = periodTotals(data, pStart, pEnd, econ);
  const labels = Array.from({ length: n }, (_, i) => R.addDays(start, i));
  const byDayShop = new Map(data.shop_days.map((d) => [d.day, d]));
  const metaByDay = new Map(); data.meta_days.forEach((r) => { if (r.day >= start && r.day <= end) metaByDay.set(r.day, (metaByDay.get(r.day) || 0) + (+r.spend || 0)); });
  const revS = labels.map((d) => (byDayShop.has(d) ? (+byDayShop.get(d).gross || 0) - (+byDayShop.get(d).refunds || 0) : null));
  const spS = labels.map((d) => (metaByDay.has(d) ? metaByDay.get(d) : null));
  const merS = labels.map((d, i) => (revS[i] != null && spS[i] ? revS[i] / spS[i] : null));
  // per-ad rows
  const inRange = data.meta_days.filter((r) => r.day >= start && r.day <= end);
  const groups = new Map();
  inRange.forEach((r) => { const k = normName(r.ad_name); if (!groups.has(k)) groups.set(k, { name: r.ad_name, rows: [] }); groups.get(k).rows.push(r); });
  const adRows = [...groups.values()].map((g) => { const ad = data.ads.find((a) => normName(a.base_name) === normName(g.name)); return { ...g, ad, t: sumRows(g.rows) }; }).sort((a, b) => b.t.spend - a.t.spend);
  const by = (keyFn) => { const m = new Map(); adRows.forEach((r) => { const k = keyFn(r) || 'Not in Ad Lab'; if (!m.has(k)) m.set(k, []); m.get(k).push(...r.rows); }); return [...m.entries()].map(([k, rows]) => ({ k, t: sumRows(rows) })).sort((a, b) => b.t.spend - a.t.spend); };
  const angleRows = by((r) => r.ad && (r.ad.angle || 'No angle set'));
  const campRows = (() => { const m = new Map(); inRange.forEach((r) => { const k = r.campaign || '—'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }); return [...m.entries()].map(([k, rows]) => ({ k, t: sumRows(rows) })).sort((a, b) => b.t.spend - a.t.spend); })();
  // Each ad is judged against break-even at its own average order, using its product's costs.
  const tone = (t, ad) => { const p = ad && data.products.find((x) => x.id === ad.product_id); const v = R.vsBreakEven(R.econOf(p || product), { purchases: t.purchases, roas: t.roas, cpa: t.cpa, aov: t.purchases ? t.revenue / t.purchases : null }); return !v || v.missing ? '' : v.band === 'above' ? 'good' : v.band === 'below' ? 'bad' : ''; };
  const shown = all ? adRows : adRows.slice(0, 10);
  const noData = !data.shop_days.length && !data.meta_days.length;
  return html`
    <div class="row"><h1 style="font-size:30px">Stats</h1><span class="spacer"></span>
      <div class="seg wide" role="group" aria-label="Date range">${RANGES.map(([k, l]) => html`<button class=${rk === k ? 'on' : ''} onClick=${() => setRk(k)}>${l}</button>`)}</div></div>
    <div class="grid2"><${ShopSync} ...${ctx} /><${MetaDrop} ...${ctx} /></div>
    ${noData ? html`<div class="empty">No numbers yet. Connect Shopify and add your first Ads Manager file to see stats.</div>` : html`
    <section class="tiles k6">
      <div class="tile"><div class="k">Revenue</div><div class="v">${cur.hasShop ? R.money0(cur.revenue) : '—'}</div><div class="s"><${Delta} now=${cur.revenue} prev=${prev.revenue} /> vs prior ${n} days</div></div>
      <div class="tile"><div class="k">Ad spend</div><div class="v">${cur.hasMeta ? R.money0(cur.spend) : '—'}</div><div class="s"><${Delta} now=${cur.spend} prev=${prev.spend} good="flat" /> Meta</div></div>
      <div class=${'tile ' + (cur.mer != null && cur.mer < (bev.roas || 0) ? 'warn' : '')}><div class="k">MER (blended ROAS)</div><div class="v">${R.xroas(cur.mer)}</div><div class="s">Store break-even ${R.xroas(bev.roas)}${bev.estimated ? ' (est.)' : ''} · <${Delta} now=${cur.mer} prev=${prev.mer} /></div></div>
      <div class="tile"><div class="k">Profit (est.)</div><div class="v">${cur.profit == null ? '—' : R.money0(cur.profit)}</div><div class="s">After product, postage, fees and ads${bev.estimated ? ' · uses Crew\'s cost ratio' : ''}</div></div>
      <div class="tile"><div class="k">Orders · AOV</div><div class="v">${cur.hasShop ? cur.orders : '—'} <small>· ${R.money(cur.aov)}</small></div><div class="s"><${Delta} now=${cur.orders} prev=${prev.orders} /> orders</div></div>
      <div class="tile"><div class="k">Meta ROAS · CPA</div><div class="v">${R.xroas(cur.roas)} <small>· ${R.money(cur.cpa)}</small></div><div class="s">${Math.round(cur.metaBuys)} Meta-reported buys</div></div>
    </section>
    <div class="grid2">
      <section class="panel"><h2>Revenue and ad spend</h2><${LineChart} labels=${labels} fmt=${(v, ax) => (ax ? '$' + Math.round(v) : R.money0(v))} series=${[{ name: 'Revenue (Shopify)', color: '#3D8BFF', values: revS }, { name: 'Ad spend (Meta)', color: '#C2669E', values: spS }]} /></section>
      <section class="panel"><h2>MER by day</h2><${LineChart} labels=${labels} fmt=${(v) => v.toFixed(2) + 'x'} refLine=${bev.roas ? { value: bev.roas, label: 'Store break-even ' + R.xroas(bev.roas) + (bev.estimated ? ' (est.)' : '') } : null} series=${[{ name: 'MER', color: '#3D8BFF', values: merS }]} /></section>
    </div>
    <section class="panel">
      <div class="row"><h2>Breakdown</h2><span class="spacer"></span><div class="seg wide">${[['ads', 'By ad'], ['angle', 'By angle'], ['camp', 'By campaign']].map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div></div>
      ${!inRange.length ? html`<div class="empty">No Meta rows in this range.</div>` : html`<div class="tscroll"><table class="t stats">
        <thead><tr><th>${tab === 'ads' ? 'Ad' : tab === 'angle' ? 'Angle' : 'Campaign'}</th><th>Spend</th><th>Buys</th><th>ROAS</th><th>CPA</th><th>CTR</th></tr></thead>
        <tbody>${(tab === 'ads' ? shown.map((r) => ({ k: r.name, t: r.t, ad: r.ad })) : tab === 'angle' ? angleRows : campRows).map((r) => html`<tr class=${r.ad ? 'click' : ''} onClick=${() => r.ad && setModal({ type: AdDetail, props: { adId: r.ad.id } })}>
          <td><span class="cellname">${r.ad && html`<${Media} path=${r.ad.media_path} type=${r.ad.media_type} />`}<span>${r.k}${r.ad ? html`<br/><span class="tiny muted">${R.stageLabel(r.ad.stage)}${r.ad.angle ? ' · ' + r.ad.angle : ''}</span>` : ''}</span></span></td>
          <td>${R.money0(r.t.spend)}</td><td>${Math.round(r.t.purchases)}</td><td class=${tone(r.t, r.ad)}>${R.xroas(r.t.roas)}</td><td>${R.money(r.t.cpa)}</td><td>${R.pct(r.t.ctr)}</td></tr>`)}</tbody></table></div>
        ${tab === 'ads' && adRows.length > 10 && html`<button class="link small" onClick=${() => setAll(!all)}>${all ? 'Show top 10' : `Show all ${adRows.length}`}</button>`}`}
      <p class="tiny muted" style="margin:0">ROAS and buys here are what Meta reports. MER uses real Shopify revenue. ROAS color: each ad vs. break-even at its own average order.</p>
    </section>`}`;
}

// ---------- rules ----------
const RULE_ROWS = [
  ['Budgets', [['stage1Budget', 'Stage 1 budget per ad set', '$/day'], ['boostedBudget', 'Boosted budget', '$/day'], ['boostAt', 'Boost when 30-day blended ROAS is at least', 'x']]],
  ['Test window', [['plannedDays', 'Test window', 'days'], ['checkins', 'Check-in days', 'day']]],
  ['Testing target (your rule, not break-even)', [['minPurchases', 'Minimum purchases', 'buys'], ['passARoas', 'Pass A: ROAS at least', 'x'], ['passACpa', 'Pass A: CPA at most', '$'], ['passBRoas', 'Pass B: ROAS at least', 'x'], ['passBCpa', 'Pass B: CPA at most', '$'], ['failRoas', 'Fail below ROAS', 'x'], ['strongPct', 'Strong pass: CPA at most', '% of line'], ['collapseDays', 'Back-half collapse window', 'days']]],
  ['Early stop (Pause? alerts)', [['earlyDay', 'From day', 'day'], ['earlySpend', '0–1 sales: spend at least', '$'], ['earlyMaxPurchases', '0–1 sales: purchases at most', 'buys'], ['underSpend', 'Under the fail line: spend at least', '$']]],
  ['Capacity & timing', [['slots', 'Test slots at once', 'slots'], ['testingCap', 'Testing cap, all products', '$/day'], ['stage2Min', 'Stage 2 minimum', 'days'], ['stage2Max', 'Stage 2 maximum', 'days'], ['raiseStep', 'Budget raise step', '%'], ['benchTarget', 'Tested backups to keep on the Bench', 'ads']]],
];

function Rules(ctx) {
  const { product, reload, say } = ctx;
  const [rules, setRules] = useState(() => { const r = R.rulesOf(product); const o = {}; Object.keys(r).forEach((k) => { o[k] = String(r[k]); }); o.weekendLock = !!r.weekendLock; return o; });
  const str = (v) => (v == null ? '' : String(v));
  const [pe, setPe] = useState(() => { const e = R.econOf(product); const o = { price: str(e.price), packCost: str(e.packCost), aov: str(e.ownAov) }; R.SHARED_COSTS.forEach(([k]) => { o[k] = str(e.own[k]); }); return o; });
  const [st, setSt] = useState(() => { const s0 = R.storeEcon(); const o = {}; Object.keys(R.STORE_DEFAULTS).forEach((k) => { o[k] = str(s0[k]); }); return o; });
  const [busy, setBusy] = useState(false);
  const toNum = (o) => { const r = {}; Object.keys(o).forEach((k) => { r[k] = o[k] === '' ? null : R.num(o[k]); }); return r; };
  const storeNow = toNum(st);
  const peRaw = { v: 2, ...toNum(pe) };
  const pv = R.econOf({ ...product, economics: peRaw }, storeNow);
  const crewP = ctx.data.products.find((p) => p.kind === 'crew');
  const crewE = product.kind === 'crew' ? pv : R.econOf(crewP, storeNow);
  const sb = R.storeBE(crewE, storeNow);
  const b1 = R.beAt(pv, pv.price), b2 = R.beAt(pv, pv.price * 2), bA = pv.ownAov ? R.beAt(pv, pv.ownAov) : null;
  const setP = (k) => (e) => setPe({ ...pe, [k]: e.target.value });
  const setS = (k) => (e) => setSt({ ...st, [k]: e.target.value });
  const unit = (u) => html`<span class="tiny muted">${u}</span>`;
  const save = async () => {
    setBusy(true);
    const old = R.rulesOf(product); const nr = {};
    Object.keys(R.DEFAULT_RULES).forEach((k) => { nr[k] = k === 'checkins' ? rules[k] : k === 'weekendLock' ? !!rules.weekendLock : (R.num(rules[k]) ?? R.DEFAULT_RULES[k]); });
    nr.extraAngles = (product.rules || {}).extraAngles || [];
    nr.extraConcepts = (product.rules || {}).extraConcepts || [];
    const ne = peRaw;
    const changes = Object.keys(nr).filter((k) => String(nr[k]) !== String(old[k])).map((k) => `${k}: ${old[k]} → ${nr[k]}`);
    const oe = R.econOf(product), os = R.storeEcon();
    const ob1 = R.beAt(oe, oe.price);
    if (String(oe.price) !== String(pv.price) || String(oe.packCost) !== String(pv.packCost) || R.SHARED_COSTS.some(([k]) => String(oe.own[k]) !== String(pv.own[k])) || String(oe.ownAov) !== String(pv.ownAov))
      changes.push(`${product.name} economics: 1-pack break-even ${ob1 ? R.xroas(ob1.roas) : 'not set'} → ${b1 ? R.xroas(b1.roas) : 'not set'}`);
    const storeChanged = Object.keys(R.STORE_DEFAULTS).some((k) => String(os[k] ?? '') !== String(storeNow[k] ?? ''));
    if (storeChanged) changes.push(`Store economics: avg order $${storeNow.aov}, break-even ${sb.roas ? R.xroas(sb.roas) : 'not set'}${sb.estimated ? ' (est.)' : ''}`);
    try {
      if (storeChanged) { await be.saveStore(storeNow); R.setStoreEcon(storeNow); }
      await be.update('products', product.id, { rules: nr, economics: ne });
      if (changes.length) await be.insert('learnings', { product_id: product.id, kind: 'rule_change', text: 'Rules changed: ' + changes.join('; ') });
      await reload(); say(changes.length ? 'Saved · logged in Learnings' : 'Saved');
    } catch (e) { say('Could not save: ' + e.message); }
    setBusy(false);
  };
  return html`
    <div class="row"><h1 style="font-size:30px">Rules · ${product.name}</h1><span class="spacer"></span><button class="btn primary" disabled=${busy} onClick=${save}>${busy ? 'Saving…' : 'Save changes'}</button></div>
    <p class="muted small" style="margin:-8px 0 0">Every product keeps its own copy. Every number is yours to change.</p>
    <div class="grid2">
      <section class="panel accent"><h2>${product.name} economics</h2>
        ${pv.set ? html`<div class="tiles">
          <div class="tile"><div class="k">Break-even · 1 pack</div><div class="v" style="color:var(--accent2)">${R.xroas(b1 && b1.roas)}</div><div class="s">${R.money(b1 && b1.cpa)} CPA at ${R.money(pv.price)}</div></div>
          <div class="tile"><div class="k">Break-even · 2 packs</div><div class="v" style="color:var(--accent2)">${R.xroas(b2 && b2.roas)}</div><div class="s">${R.money(b2 && b2.cpa)} CPA at ${R.money(pv.price * 2)}, full price</div></div>
          ${bA && html`<div class="tile"><div class="k">At its avg order</div><div class="v" style="color:var(--accent2)">${R.xroas(bA.roas)}</div><div class="s">${R.money(bA.cpa)} CPA at ${R.money(pv.ownAov)} · estimate</div></div>`}
          <div class="tile"><div class="k">Testing pass line</div><div class="v">${R.xroas(R.num(rules.passARoas))}</div><div class="s">Your rule, not break-even</div></div></div>
          <p class="tiny muted" style="margin:0">Each ad is also checked against break-even at its own average order. 1 and 2 full-price packs are exact; other order sizes assume the extra is more packs, so they're marked as estimates.</p>`
        : html`<div class="status warn small">Costs not set. Enter the pack price and product cost to see break-even. Nothing is guessed.</div>`}
        <div class="rulerow"><label for="e-price">Pack price</label><input id="e-price" inputmode="decimal" value=${pe.price} onInput=${setP('price')} />${unit('$')}</div>
        <div class="rulerow"><label for="e-cost">Product cost per pack</label><input id="e-cost" inputmode="decimal" value=${pe.packCost} onInput=${setP('packCost')} />${unit('$')}</div>
        <div class="rulerow"><label for="e-aov">This product's average order (optional)</label><input id="e-aov" inputmode="decimal" value=${pe.aov} onInput=${setP('aov')} placeholder="—" />${unit('$')}</div>
        <div class="fsec">Shared costs · blank uses the store's</div>
        ${R.SHARED_COSTS.map(([k, l, u]) => html`<div class="rulerow"><label for=${'e-' + k}>${l}${pe[k] === '' ? html` <span class="tiny muted">(store)</span>` : html` <button class="link tiny" onClick=${() => setPe({ ...pe, [k]: '' })}>use store</button>`}</label><input id=${'e-' + k} inputmode="decimal" value=${pe[k]} placeholder=${st[k] || '0'} onInput=${setP(k)} />${unit(u)}</div>`)}
      </section>
      <section class="panel"><h2>Store economics</h2>
        <p class="small muted" style="margin:0">The whole shop, blended. Shared by every product. Used for MER and profit on Stats.</p>
        <div class="tiles"><div class="tile"><div class="k">Store break-even</div><div class="v">${sb.missing ? '—' : R.xroas(sb.roas)}</div><div class="s">${sb.missing ? 'Needs average order and product cost' : R.money(sb.cpa) + ' CPA at ' + R.money(sb.V)}</div></div></div>
        ${sb.estimated && html`<div class="status warn small"><b>Estimate.</b> Uses Crew's product cost ratio (${sb.pct.toFixed(0)}% of sales) until you enter the store's own average below.</div>`}
        <div class="rulerow"><label for="s-aov">Store average order</label><input id="s-aov" inputmode="decimal" value=${st.aov} onInput=${setS('aov')} />${unit('$')}</div>
        <div class="rulerow"><label for="s-cogs">Product cost, % of sales (all products)</label><input id="s-cogs" inputmode="decimal" value=${st.cogsPct} placeholder="not known yet" onInput=${setS('cogsPct')} />${unit('%')}</div>
        ${R.SHARED_COSTS.map(([k, l, u]) => html`<div class="rulerow"><label for=${'s-' + k}>${l}</label><input id=${'s-' + k} inputmode="decimal" value=${st[k]} onInput=${setS(k)} />${unit(u)}</div>`)}
      </section>
      <section class="panel"><h2>Angles</h2><p class="small muted" style="margin:0">The main message each ad leads with. A short fixed list keeps results comparable.</p>
        <div class="list">${R.ANGLES.map((x) => html`<div class="li"><span class="grow small"><b>${x.name}</b><br/><span class="muted">${x.hint} Examples: ${x.examples.join(' · ')}</span></span></div>`)}
          ${((product.rules || {}).extraAngles || []).map((x) => html`<div class="li"><span class="grow small"><b>${x}</b><br/><span class="muted">Added by you</span></span><button class="link small" style="color:var(--fail)" onClick=${async () => { if (!confirm('Remove the angle "' + x + '"? Ads keep it until you change them.')) return; await be.update('products', product.id, { rules: { ...(product.rules || {}), extraAngles: ((product.rules || {}).extraAngles || []).filter((y) => y !== x) } }); await reload(); say('Angle removed'); }}>Remove</button></div>`)}</div>
        <div class="row"><button class="btn sm" onClick=${() => addAngle(product, reload, say)}>+ Add angle</button></div></section>
      <section class="panel"><h2>Concepts</h2><p class="small muted" style="margin:0">What the picture or video shows. A short fixed list keeps results comparable.</p>
        <div class="list">${R.CONCEPTS.map((x) => html`<div class="li"><span class="grow small"><b>${x.name}</b><br/><span class="muted">${x.hint} Your ads: ${x.examples.join(' · ')}</span></span></div>`)}
          ${((product.rules || {}).extraConcepts || []).map((x) => html`<div class="li"><span class="grow small"><b>${x}</b><br/><span class="muted">Added by you</span></span><button class="link small" style="color:var(--fail)" onClick=${async () => { if (!confirm('Remove the concept "' + x + '"?')) return; await be.update('products', product.id, { rules: { ...(product.rules || {}), extraConcepts: ((product.rules || {}).extraConcepts || []).filter((y) => y !== x) } }); await reload(); say('Concept removed'); }}>Remove</button></div>`)}</div>
        <div class="row"><button class="btn sm" onClick=${() => addConcept(product, reload, say)}>+ Add concept</button></div></section>
      ${RULE_ROWS.map(([title, rows]) => html`<section class="panel"><h2>${title}</h2>${rows.map(([k, l, u]) => html`<div class="rulerow"><label for=${'r-' + k}>${l}</label><input id=${'r-' + k} inputmode=${k === 'checkins' ? 'text' : 'decimal'} value=${rules[k]} onInput=${(e) => setRules({ ...rules, [k]: e.target.value })} /><span class="tiny muted">${u}</span></div>`)}
        ${title === 'Capacity & timing' && html`<label class="chk"><input type="checkbox" checked=${rules.weekendLock} onChange=${(e) => setRules({ ...rules, weekendLock: e.target.checked })} /> Weekend lock warnings (Friday night to Sunday)</label>`}</section>`)}
    </div>`;
}

// ---------- learnings ----------
function Learn(ctx) {
  const { data, product, reload, say } = ctx;
  const [text, setText] = useState(''); const [kind, setKind] = useState('learning');
  const [ev, setEv] = useState({ day: R.today(), kind: 'Website change', note: '', all: true });
  const items = [
    ...data.learnings.filter((l) => !l.product_id || l.product_id === product.id).map((l) => ({ day: l.day, tag: l.kind === 'rule_change' ? 'Rule change' : l.kind === 'hypothesis' ? 'Hypothesis' : 'Learning', tone: l.kind === 'rule_change' ? 'mid' : l.kind === 'hypothesis' ? 'muted' : 'pass', text: l.text, src: l.source, id: l.id, t: 'learnings' })),
    ...data.events.filter((e) => !e.product_id || e.product_id === product.id).map((e) => ({ day: e.day, tag: 'Change', tone: 'ins', text: `${e.kind}${e.note ? ': ' + e.note : ''}`, id: e.id, t: 'events' })),
    ...data.decisions.filter((d) => d.product_id === product.id).map((d) => { const ad = data.ads.find((a) => a.id === d.ad_id); return { day: d.day, tag: 'Decision', tone: 'live', text: `${d.choice}${ad ? ' · ' + ad.base_name : ''}${d.reason ? ' · ' + d.reason : ''}` }; }),
  ].sort((a, b) => String(b.day).localeCompare(String(a.day)));
  const addL = async () => { if (!text.trim()) return; await be.insert('learnings', { product_id: product.id, kind, text: text.trim() }); setText(''); await reload(); say('Saved'); };
  const addE = async () => { await be.insert('events', { product_id: ev.all ? null : product.id, day: ev.day, kind: ev.kind, note: ev.note }); setEv({ ...ev, note: '' }); await reload(); say('Change logged'); };
  return html`
    <h1 style="font-size:30px">Learnings · ${product.name}</h1>
    <div class="grid2">
      <section class="panel"><h2>Add a learning</h2><div class="form">
        <${Field} full label="One statement you can test"><textarea value=${text} onInput=${(e) => setText(e.target.value)} placeholder="Person wearing it in the first frame beat packaging-first"></textarea><//>
        <${Field} label="Type"><select value=${kind} onChange=${(e) => setKind(e.target.value)}><option value="learning">Learning (proven)</option><option value="hypothesis">Hypothesis (not proven)</option></select><//></div>
        <div class="row"><button class="btn primary" onClick=${addL}>Save</button></div></section>
      <section class="panel"><h2>Log a change</h2><p class="small muted" style="margin:0">Site, offer, stock, tracking or Meta changes. Tests running then get flagged.</p><div class="form">
        <${Field} label="Date"><input type="date" value=${ev.day} onInput=${(e) => setEv({ ...ev, day: e.target.value })} /><//>
        <${Field} label="Type"><select value=${ev.kind} onChange=${(e) => setEv({ ...ev, kind: e.target.value })}>${['Website change', 'Offer or price change', 'Stock problem', 'Tracking problem', 'Meta changed settings', 'Email sent', 'Other'].map((k) => html`<option>${k}</option>`)}</select><//>
        <${Field} full label="What happened"><input value=${ev.note} onInput=${(e) => setEv({ ...ev, note: e.target.value })} /><//>
        <label class="chk full"><input type="checkbox" checked=${ev.all} onChange=${(e) => setEv({ ...ev, all: e.target.checked })} /> Affects every product</label></div>
        <div class="row"><button class="btn" onClick=${addE}>Log change</button></div></section>
    </div>
    <section class="panel"><h2>History</h2>${items.length ? html`<div class="list">${items.map((it) => html`<div class="li"><span class="mono small muted" style="width:52px">${R.shortDate(it.day)}</span><span class=${'chip t-' + it.tone}>${it.tag}</span><span class="grow small">${it.text}${it.src ? html` <span class="muted">· ${it.src}</span>` : ''}</span></div>`)}</div>` : html`<div class="empty">Nothing yet</div>`}</section>`;
}

// ---------- more ----------
function ZipAll({ data }) {
  const [st, setSt] = useState(null);
  const go = async () => {
    if (!window.JSZip) { setSt('The zip tool did not load. Refresh and try again.'); return; }
    const zip = new window.JSZip(); const used = new Set();
    const jobs = [];
    for (const ad of data.ads) {
      const prod = (data.products.find((p) => p.id === ad.product_id) || {}).name || 'Other';
      const files = [ad.media_path ? { path: ad.media_path, label: '' } : null, ...(((ad.tags || {}).files) || []).map((x) => ({ path: x.path, label: x.label || 'extra' }))].filter(Boolean);
      files.forEach((x) => jobs.push({ ad, prod, ...x }));
    }
    let n = 0;
    for (const j of jobs) {
      n++; setSt(`Downloading ${n} of ${jobs.length}…`);
      try {
        const url = await be.mediaUrl(j.path); const blob = await (await fetch(url)).blob();
        let name = `${safeName(j.prod)}/${R.stageLabel(j.ad.stage)}/${safeName(j.ad.base_name)}${j.label ? ' - ' + safeName(j.label) : ''}.${j.path.split('.').pop()}`;
        while (used.has(name)) name = name.replace(/(\.[^.]+)$/, ' (2)$1'); used.add(name);
        zip.file(name, blob);
      } catch (e) { /* skip missing files */ }
    }
    setSt('Making the zip…');
    const out = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(out); a.download = `bureen-ad-media-${R.today()}.zip`; document.body.appendChild(a); a.click(); a.remove();
    setSt(`Done: ${jobs.length} files.`);
  };
  return html`<section class="panel"><h2>Download all media</h2><p class="small muted" style="margin:0">Every image and video, in folders by product and stage. A backup like your OneDrive.</p>
    <div class="row"><button class="btn" onClick=${go}>Download zip</button></div>${st && html`<div class="status live small">${st}</div>`}</section>`;
}

function More(ctx) {
  const { data, reload, say, setView } = ctx;
  const [prog, setProg] = useState(null);
  const already = data.ads.some((a) => a.history && a.history.importId);
  const exportAll = async () => {
    const all = await be.loadAll();
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...all }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `bureen-ad-lab-${R.today()}.json`; document.body.appendChild(a); a.click(); a.remove();
  };
  const runImport = async (file) => {
    if (!file) return;
    setProg({ done: 0, total: 0, msg: 'Opening file…' });
    try { const r = await importHistory(file, be, data, (p) => setProg(p)); await reload(); setProg({ msg: `Imported ${r.added} new ad${r.added === 1 ? '' : 's'}${r.resorted ? `, re-sorted ${r.resorted}` : ''}.` }); say('History imported'); }
    catch (e) { setProg({ msg: 'Import failed: ' + e.message, error: true }); }
  };
  return html`
    <h1 style="font-size:30px">More</h1>
    <div class="grid2">
      <section class="panel"><h2>Angles</h2><p class="small muted" style="margin:0">How each angle and concept has done, with every ad that ran it.</p><div class="row"><button class="btn" onClick=${() => setView('angles')}>Open Angles</button></div></section>
      <${ZipAll} data=${data} />
      <section class="panel"><h2>Rules</h2><p class="small muted" style="margin:0">Testing rules, break-even and costs per product.</p><div class="row"><button class="btn" onClick=${() => setView('rules')}>Open Rules</button></div></section>
      <section class="panel"><h2>Learnings</h2><p class="small muted" style="margin:0">Learnings, changes and every decision, per product.</p><div class="row"><button class="btn" onClick=${() => setView('learn')}>Open Learnings</button></div></section>
      <section class="panel"><h2>Import your ad history</h2>
        <p class="small muted" style="margin:0">Load the history file from Claude once: your past ads, images, verdicts and notes.</p>
        ${already && html`<div class="status good">History is imported. Importing a newer history file re-sorts ads you have not moved yourself.</div>`}
        <input type="file" accept=".zip" class="inp" onChange=${(e) => runImport(e.target.files[0])} />
        ${prog && html`<div class=${'status ' + (prog.error ? 'bad' : 'live')}>${prog.msg}${prog.total ? ` (${prog.done}/${prog.total})` : ''}</div>`}
      </section>
      <section class="panel"><h2>Backup</h2><p class="small muted" style="margin:0">Download everything as one file. Images stay in your storage.</p><div class="row"><button class="btn" onClick=${exportAll}>Export everything</button></div></section>
      <section class="panel"><h2>Install on your phone</h2><p class="small muted" style="margin:0">iPhone: open this page in Safari, tap Share, then Add to Home Screen. Android: Chrome menu, then Add to Home screen.</p></section>
      ${be.mock && html`<section class="panel"><h2>Test mode</h2><p class="small muted" style="margin:0">Test data lives only in this browser. Clearing it does not touch your real database.</p><div class="row"><button class="btn danger" onClick=${async () => { if (!confirm('Clear all test data in this browser?')) return; await be.reset(); location.reload(); }}>Clear test data</button></div></section>`}
      <section class="panel"><h2>Account</h2><div class="row"><button class="btn" onClick=${() => be.signOut()}>Sign out</button></div></section>
    </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
