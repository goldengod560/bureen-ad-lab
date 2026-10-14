import { h, render } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import htm from 'htm';
import { createBackend } from './data.js?v=12';
import * as R from './rules.js?v=12';
import { importHistory } from './importer.js?v=12';
import { readMetaFile, rowsForAd, sumRows, normName } from './metafile.js?v=12';

const html = htm.bind(h);
const be = createBackend();

// ---------- small helpers ----------
const byCreated = (a, b) => String(a.created_at).localeCompare(String(b.created_at));
const displayName = (ad) => ad.base_name + (ad.launched_on ? ' | ' + R.shortDate(ad.launched_on) : '');
const toneOf = (result) => (R.RESULTS[result] || {}).tone || 'muted';
const extOf = (file) => (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
let toastTimer;

function Toast({ msg }) { return msg ? html`<div class="toast" role="status">${msg}</div>` : null; }

function Media({ path, type, cls, onOpen, big }) {
  const [url, setUrl] = useState(null);
  useEffect(() => { let on = true; if (path) be.mediaUrl(path).then((u) => on && setUrl(u)).catch(() => {}); else setUrl(null); return () => { on = false; }; }, [path]);
  const isVid = /^video\//.test(type || '');
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
  const [stage, setStage] = useState('testing');
  const [modal, setModal] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

  const say = (m) => { setToast(m); clearTimeout(toastTimer); toastTimer = setTimeout(() => setToast(''), 2800); };
  const reload = async () => { try { const d = await be.loadAll(); d.ads = d.ads.map(R.normalizeAd); setData(d); } catch (e) { say('Could not load: ' + e.message); } };

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

  if (!be.configured) return html`<div class="login"><div class="panel"><div class="brand"><i></i>BUREEN<b>AD LAB</b></div>
    <p>The app isn't connected to its database yet. Add the Supabase URL and anon key to <code>js/config.js</code>.</p>
    <p class="muted small">To try it without a database, open this page with <code>?mock=1</code> at the end of the address.</p></div></div>`;
  if (session === undefined) return html`<div class="login muted">Loading…</div>`;
  if (!session) return html`<${Login} />`;
  if (!data) return html`<div class="login muted">Loading your ads…</div>`;

  const products = data.products.filter((p) => !p.archived).sort((a, b) => a.sort - b.sort);
  const product = products.find((p) => p.id === pid) || products[0];
  const ctx = { data, product, products, reload, say, setModal, setLightbox, busy, setBusy, setView };

  const activeStage1 = data.tests.filter((t) => t.status === 'active' && t.stage === 1);
  const rules0 = R.rulesOf(product);
  const NAV = [['today', 'Today'], ['board', 'Board'], ['stats', 'Stats'], ['angles', 'Angles'], ['rules', 'Rules'], ['learn', 'Learnings'], ['more', 'More']];

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
      ${R.isWeekendLock() && html`<div class="banner"><b>Weekend lock.</b> Your rule: no new ads, reactivations or budget changes Friday night through Sunday.</div>`}
      ${view !== 'more' && view !== 'today' && view !== 'stats' && html`<${ProductTabs} ...${ctx} setPid=${setPid} />`}
      ${view === 'board' && html`<${Board} ...${ctx} stage=${stage} setStage=${setStage} />`}
      ${view === 'today' && html`<${Today} ...${ctx} setPid=${setPid} />`}
      ${view === 'stats' && html`<${Stats} ...${ctx} />`}
      ${view === 'angles' && html`<${Angles} key=${product.id} ...${ctx} />`}
      ${view === 'rules' && html`<${Rules} key=${product.id} ...${ctx} />`}
      ${view === 'learn' && html`<${Learn} ...${ctx} />`}
      ${view === 'more' && html`<${More} ...${ctx} />`}
    </main>
    <nav class="bnav" aria-label="Main">${[['today', 'Today'], ['board', 'Board'], ['stats', 'Stats'], ['angles', 'Angles'], ['more', 'More']].map(([k, l]) => html`<button class=${view === k || (k === 'more' && (view === 'learn' || view === 'rules')) ? 'on' : ''} onClick=${() => setView(k)}>${l}</button>`)}</nav>
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
const histStats = (ad) => { const h = ad.history || {}; return h.roas != null ? `${R.xroas(h.roas)} · ${R.money(h.cpa)} CPA · ${R.money0(h.spend)}` : null; };
const lastTestLine = (t) => t && t.result_reason ? t.result_reason : '';
function cardInfo(ad, ctx) {
  const { data, product } = ctx;
  const tests = data.tests.filter((t) => t.ad_id === ad.id).sort(byCreated);
  const t = tests[tests.length - 1];
  const rules = R.rulesOf(product), econ = R.econOf(product);
  const tags = ad.tags || {};
  const stats = histStats(ad);
  const resLabel = (R.RESULTS[ad.result] || {}).label;
  switch (ad.stage) {
    case 'testing': {
      if (!t) return { line: 'No test record', chip: 'Testing', tone: 'live', glow: 'live' };
      const st = R.testStatus(t, data.checkpoints.filter((c) => c.test_id === t.id), rules, econ.aov);
      if (st.due.length) return { line: `Day ${st.day} of ${st.planned}. Day ${st.due[st.due.length - 1]} results due.`, chip: 'Results due', tone: 'mid', glow: 'live' };
      if (st.final) return { line: st.text, chip: 'Finalize', tone: 'live', glow: 'live' };
      if (st.early) return { line: st.text, chip: 'Early stop?', tone: 'fail', glow: 'live' };
      return { line: st.text, chip: `Day ${Math.min(st.day, st.planned)}/${st.planned}`, tone: 'live', glow: 'live' };
    }
    case 'untested': return { line: (ad.notes || '').split('\n')[0] || (tags.retest && stats) || ad.angle || ad.concept || 'Idea', chip: tags.ready ? 'Ready' : tags.retest ? 'Retest' : ad.parent_id ? 'Recycled' : 'Idea', tone: tags.ready ? 'live' : tags.retest ? 'ins' : 'muted', glow: tags.ready ? 'live' : null };
    case 'bench': return { line: stats || lastTestLine(t), chip: ad.result === 'strong_pass' ? 'Strong pass' : null, tone: 'pass', glow: 'pass' };
    case 'main': {
      const s2 = tests.find((x) => x.stage === 2 && x.status === 'active');
      if (s2) { const d = R.testDay(s2); return { line: `Day ${d} in Main. Judge after ${rules.stage2Min} to ${rules.stage2Max} days.` + (stats ? ' · ' + stats : ''), chip: `Day ${Math.min(d, rules.stage2Max)}/${rules.stage2Max} in Main`, tone: 'live', glow: 'live' }; }
      return { line: (tags.fatiguing ? 'Fatiguing' : 'Running') + (stats ? ' · ' + stats : ''), chip: tags.fatiguing ? 'Fatiguing' : 'Running', tone: tags.fatiguing ? 'mid' : 'pass', glow: tags.fatiguing ? 'mid' : 'pass' };
    }
    case 'exhausted': return { line: [tags.offReason ? 'Off: ' + tags.offReason : 'Off', stats].filter(Boolean).join(' · '), chip: null, tone: 'muted' };
    case 'seasonal': return { line: stats || ad.notes || '', chip: tags.season || 'Seasonal', tone: 'ins' };
    default: return { line: stats || lastTestLine(t), chip: null, tone: toneOf(ad.result) };
  }
}

function Card(props) {
  const { ad, setModal } = props; const ci = cardInfo(ad, props);
  return html`<button type="button" class=${'card' + (ci.glow ? ' glow-' + ci.glow : '')} onClick=${() => setModal({ type: AdDetail, props: { adId: ad.id } })}>
    <${Media} path=${ad.media_path} type=${ad.media_type} />
    <span class="t"><span class="nm">${displayName(ad)}</span><span class="ln">${ci.line}</span>
      <span class="chips">${ci.chip && html`<span class=${'chip t-' + ci.tone}>${ci.chip}</span>`}${ad.stage === 'untested' && ad.tags && ad.tags.review && html`<span class=${'chip t-' + (ad.tags.review.score >= 80 ? 'pass' : ad.tags.review.score >= 60 ? 'mid' : 'fail')}>Check ${ad.tags.review.score}</span>`}${ad.setup_era === 'era1' && !['failed', 'mid'].includes(ad.stage) && html`<span class="chip t-muted" title=${R.ERAS.era1.note}>Era 1</span>`}</span></span>
  </button>`;
}

// Sub-groups inside a column. null = no grouping.
const GROUPS = {
  untested: [['Ready to launch', (a) => a.tags && a.tags.ready], ['Retest', (a) => a.tags && a.tags.retest], ['Ideas', () => true]],
  main: [['On trial', (a, c) => c.data.tests.some((t) => t.ad_id === a.id && t.stage === 2 && t.status === 'active')], ['Running', () => true]],
  mid: [['Era 2 and later', (a) => a.setup_era !== 'era1'], ['Era 1 · weak evidence', () => true]],
  failed: [['Era 2 and later', (a) => a.setup_era !== 'era1'], ['Era 1 · never a fair shot', () => true]],
};
function StageList({ stageKey, list, ctx }) {
  const [open, setOpen] = useState({});
  if (!list.length) return html`<div class="empty">Nothing here</div>`;
  const groups = GROUPS[stageKey];
  if (!groups) return list.map((ad) => html`<${Card} key=${ad.id} ad=${ad} ...${ctx} />`);
  const left = [...list];
  return groups.map(([label, fn]) => {
    const g = left.filter((a) => fn(a, ctx)); g.forEach((a) => left.splice(left.indexOf(a), 1));
    if (!g.length) return null;
    const shown = open[label] ? g : g.slice(0, 3);
    return html`<div class="grp"><span>${label}</span><span>${g.length}</span></div>
      ${shown.map((ad) => html`<${Card} key=${ad.id} ad=${ad} ...${ctx} />`)}
      ${g.length > 3 && html`<button class="link small" style="align-self:flex-start" onClick=${() => setOpen({ ...open, [label]: !open[label] })}>${open[label] ? 'Show less' : `Show all ${g.length}`}</button>`}`;
  });
}

function benchHealth(data, product) {
  const rules = R.rulesOf(product);
  const ads = data.ads.filter((a) => a.product_id === product.id);
  const bench = ads.filter((a) => a.stage === 'bench').length;
  const main = ads.filter((a) => a.stage === 'main');
  const fatiguing = main.filter((a) => a.tags && a.tags.fatiguing);
  return { bench, target: rules.benchTarget, main: main.length, fatiguing, low: bench < rules.benchTarget, urgent: fatiguing.length > 0 && bench < Math.max(1, rules.benchTarget) };
}

function ShelfPanel({ shelf, list, ctx, close }) {
  return html`<section class="panel"><div class="row"><h2>${R.stageLabel(shelf)}</h2><span class="muted small">${R.SHELVES.find((s) => s.key === shelf).hint}</span><span class="spacer"></span><button class="btn sm ghost" onClick=${close}>Close</button></div>
    <div class="shelf">${list.length ? list.map((ad) => html`<${Card} key=${ad.id} ad=${ad} ...${ctx} />`) : html`<div class="empty">Nothing here</div>`}</div></section>`;
}

function Board(ctx) {
  const { data, product, stage, setStage, setModal } = ctx;
  const [shelf, setShelf] = useState(null);
  const ads = data.ads.filter((a) => a.product_id === product.id);
  const by = (k) => ads.filter((a) => a.stage === k).sort((a, b) => (b.launched_on || b.created_at || '').localeCompare(a.launched_on || a.created_at || ''));
  const econ = R.econOf(product), bev = R.breakEven(econ);
  const live = data.tests.filter((t) => t.status === 'active' && t.product_id === product.id && t.stage === 1);
  const bh = benchHealth(data, product);
  const cur = R.STAGES.find((s) => s.key === stage) || R.STAGES[1];
  const newAd = () => setModal({ type: AdForm, props: { mode: 'new' } });
  return html`
    <section class="tiles" aria-label="Summary">
      <div class="tile"><div class="k">Break-even</div><div class="v">${R.xroas(bev.roas)}</div><div class="s">${R.money(bev.cpa)} CPA at ${R.money(econ.aov)} avg order</div></div>
      <div class="tile"><div class="k">Testing now</div><div class="v">${live.length}</div><div class="s">${by('untested').filter((a) => a.tags && a.tags.ready).length} ready to launch</div></div>
      <div class="tile"><div class="k">In Main</div><div class="v">${bh.main}</div><div class="s">${bh.fatiguing.length ? bh.fatiguing.length + ' fatiguing' : 'none fatiguing'}</div></div>
      <div class=${'tile' + (bh.urgent ? ' warn' : '')}><div class="k">Bench</div><div class="v">${bh.bench} <small>/ ${bh.target}</small></div><div class="s">${bh.urgent ? 'Low, and Main is fatiguing' : bh.low ? 'Under your target' : 'Backups ready'}</div></div>
    </section>
    <div class="row board-new">${R.SHELVES.map((s) => html`<button class=${'btn sm ghost' + (shelf === s.key ? ' on' : '')} onClick=${() => setShelf(shelf === s.key ? null : s.key)}>${s.label} · ${by(s.key).length}</button>`)}<span class="spacer"></span><button class="btn primary" onClick=${newAd}>+ New ad</button></div>
    ${shelf && html`<div class="lap-only"><${ShelfPanel} shelf=${shelf} list=${by(shelf)} ctx=${ctx} close=${() => setShelf(null)} /></div>`}
    <div class="board-scroll"><div class="board">
      ${R.STAGES.map((s) => { const list = by(s.key);
        return html`<section class=${'col ' + s.key} aria-label=${s.label}><h2>${s.label}<span>${list.length}</span></h2><div class="hint">${s.hint}</div>
          <${StageList} stageKey=${s.key} list=${list} ctx=${ctx} /></section>`; })}
    </div></div>
    <div class="stagepick" role="tablist" aria-label="Stages">
      ${R.STAGES.map((s) => html`<button role="tab" aria-selected=${s.key === stage} class=${s.key === stage ? 'on' : ''} onClick=${() => setStage(s.key)}><b>${s.label}</b><span>${by(s.key).length}</span></button>`)}
      <button onClick=${newAd}><b>+ New</b><span>ad</span></button>
    </div>
    <div class="phonelist">
      <div class="row"><h2 style="font-size:20px">${cur.label}</h2><span class="spacer"></span><span class="muted small">${cur.hint}</span></div>
      <${StageList} stageKey=${cur.key} list=${by(cur.key)} ctx=${ctx} />
      <div class="row" style="margin-top:6px">${R.SHELVES.map((s) => html`<button class="btn sm ghost" onClick=${() => setShelf(shelf === s.key ? null : s.key)}>${s.label} · ${by(s.key).length}</button>`)}</div>
      ${shelf && html`<${ShelfPanel} shelf=${shelf} list=${by(shelf)} ctx=${ctx} close=${() => setShelf(null)} />`}
    </div>`;
}

// ---------- ad detail ----------
// How every ad sharing this concept has done. Era 1 results are shown but not counted.
function conceptStats(data, concept) {
  if (!concept) return null;
  const fam = data.ads.filter((a) => a.concept && a.concept.trim().toLowerCase() === concept.trim().toLowerCase());
  const counted = fam.filter((a) => a.setup_era !== 'era1' && a.stage !== 'untested' && a.stage !== 'testing');
  const won = counted.filter((a) => ['pass', 'strong_pass', 'held'].includes(a.result) || ['bench', 'main', 'exhausted'].includes(a.stage));
  const lastRun = fam.map((a) => a.launched_on || '').filter(Boolean).sort().pop() || null;
  return { fam, counted: counted.length, won: won.length, era1: fam.filter((a) => a.setup_era === 'era1').length, lastRun };
}
const allAngles = (data) => [...new Set(data.ads.map((a) => (a.angle || '').trim()).filter(Boolean))].sort();
const allConcepts = (data) => [...new Set(data.ads.map((a) => (a.concept || '').trim()).filter(Boolean))].sort();

function ConceptPanel({ ad, data, reload, say, setModal }) {
  const [val, setVal] = useState(ad.concept || '');
  const [ang, setAng] = useState(ad.angle || '');
  const saveAng = async () => { if ((ang || '') === (ad.angle || '')) return; await be.update('ads', ad.id, { angle: ang.trim() || null }); await reload(); say('Angle saved'); };
  const angles = [...new Set(data.ads.map((a) => (a.angle || '').trim()).filter(Boolean))].sort();
  const cs = conceptStats(data, ad.concept);
  const save = async () => { if ((val || '') === (ad.concept || '')) return; await be.update('ads', ad.id, { concept: val.trim() || null }); await reload(); say('Concept saved'); };
  return html`<div class="panel"><div class="row"><h2>Angle</h2><span class="spacer"></span>
      <input class="inp" style="max-width:240px;min-height:34px" list="angle-list" value=${ang} placeholder="$6 per shirt" onInput=${(e) => setAng(e.target.value)} onBlur=${saveAng} onKeyDown=${(e) => e.key === 'Enter' && e.target.blur()} aria-label="Angle" /></div>
    <datalist id="angle-list">${angles.map((c) => html`<option value=${c} />`)}</datalist>
    <div class="row"><h2>Concept</h2><span class="spacer"></span>
      <input class="inp" style="max-width:240px;min-height:34px" list="concept-list" value=${val} placeholder="Name the idea" onInput=${(e) => setVal(e.target.value)} onBlur=${save} onKeyDown=${(e) => e.key === 'Enter' && e.target.blur()} aria-label="Concept" /></div>
    <datalist id="concept-list">${allConcepts(data).map((c) => html`<option value=${c} />`)}</datalist>
    ${cs && cs.fam.length > 1 ? html`
      <div class="small">${cs.fam.length} versions${cs.counted ? ` · Era 2 and later: ${cs.won} of ${cs.counted} worked` : ' · none tested since Era 1'}${cs.era1 ? ` · ${cs.era1} from Era 1 (not counted)` : ''}</div>
      ${cs.fam.length >= 5 && html`<div class="status warn small">You've run this concept ${cs.fam.length} times. Change something real (hook, first frame, offer), not just the text.</div>`}
      <div class="fam">${cs.fam.filter((f) => f.id !== ad.id).map((f) => html`<button class="famitem" onClick=${() => setModal({ type: AdDetail, props: { adId: f.id } })}><${Media} path=${f.media_path} type=${f.media_type} /><span class="small">${f.base_name}</span><span class=${'chip t-' + (f.result ? toneOf(f.result) : 'muted')}>${R.stageLabel(f.stage)}${f.setup_era === 'era1' ? ' · Era 1' : ''}</span></button>`)}</div>`
    : html`<div class="small muted">${ad.concept ? 'The only ad with this concept so far.' : 'Group versions of the same idea (same footage or shot, different text) so you can see how the idea has done overall.'}</div>`}
  </div>`;
}

function AdDetail(ctx) {
  const { data, adId, close, setModal, setLightbox, reload, say } = ctx;
  const ad = data.ads.find((a) => a.id === adId);
  const [confirmDel, setConfirmDel] = useState(false);
  if (!ad) return null;
  const product = data.products.find((p) => p.id === ad.product_id) || ctx.product;
  const rules = R.rulesOf(product), econ = R.econOf(product);
  const tests = data.tests.filter((t) => t.ad_id === ad.id).sort(byCreated);
  const active = tests.find((t) => t.status === 'active');
  const hist = ad.history || {};
  const tags = ad.tags || {};
  const family = data.ads.filter((a) => a.id !== ad.id && (a.parent_id === ad.id || a.id === ad.parent_id || (ad.parent_id && a.parent_id === ad.parent_id)));
  const decisions = data.decisions.filter((d) => d.ad_id === ad.id).sort((a, b) => String(b.day).localeCompare(String(a.day)));
  const open = (type, props) => setModal({ type, props: { adId: ad.id, ...props } });
  const log = (kind, choice, reason) => be.insert('decisions', { product_id: ad.product_id, ad_id: ad.id, kind, choice, reason: reason || '' });
  const move = async (to, note, patch) => {
    try { await be.update('ads', ad.id, { stage: to, ...(patch || {}) }); }
    catch (e) { say('Could not move: ' + e.message); await reload(); return; }
    try { await log('move', `Moved to ${R.stageLabel(to)}`, note); } catch (e) { console.warn('decision log failed', e); }
    await reload(); say('Moved to ' + R.stageLabel(to));
  };
  const setTag = async (k, v, msg) => { await be.update('ads', ad.id, { tags: { ...tags, [k]: v } }); await reload(); say(msg); };
  const del = async () => { await be.remove('ads', ad.id); await reload(); close(); say('Deleted'); };

  const A = (label, fn, cls) => html`<button class=${'btn ' + (cls || '')} onClick=${fn}>${label}</button>`;
  const actions = [];
  switch (ad.stage) {
    case 'untested':
      actions.push(A(tags.review ? `Check: ${tags.review.score}/100` : 'Pre-launch check', () => open(ReviewForm), tags.review ? '' : 'primary'));
      actions.push(A('It went live in Meta', () => open(LaunchForm), tags.ready ? 'primary' : ''));
      actions.push(A(tags.ready ? 'Not ready yet' : 'Mark ready to launch', () => setTag('ready', !tags.ready, tags.ready ? 'Back to ideas' : 'Marked ready'), 'ghost'));
      actions.push(A('Straight to Main (no test)', () => open(MainForm, { mode: 'start', emergency: true }), 'ghost'));
      break;
    case 'testing':
      if (active) actions.push(A('Add results', () => open(CheckinForm, { testId: active.id }), 'primary'), A('Finalize', () => open(FinalizeForm, { testId: active.id })), A('Stop early', () => open(StopForm, { testId: active.id }), 'danger'));
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
      actions.push(A('Retest as is', () => move('untested', 'Retest as is', { tags: { ...tags, retest: true, ready: false } })));
      break;
    case 'failed':
      actions.push(A('Recycle with a fix', () => setModal({ type: AdForm, props: { mode: 'version', adId: ad.id, recycle: true } })));
      if (ad.setup_era === 'era1') actions.push(A('Retest (Era 1 result)', () => move('untested', 'Retest: Era 1 result was not a fair test', { tags: { ...tags, retest: true, ready: false } })));
      break;
    case 'seasonal':
      actions.push(A('Move to Untested', () => move('untested', 'Pulled from Seasonal')));
      break;
  }
  const era = R.ERAS[ad.setup_era];

  return html`<${Modal} wide title=${displayName(ad)} sub=${product.name + ' · ' + (ad.format || 'image')} onClose=${close}>
    <div class="detail">
      <div class="stack">
        <${Media} big path=${ad.media_path} type=${ad.media_type} onOpen=${(url, video) => setLightbox({ url, video })} />
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
          ${ad.stage === 'untested' && tags.ready && html`<span class="chip t-live">Ready</span>`}
          ${ad.stage === 'untested' && tags.retest && html`<span class="chip t-ins">Retest</span>`}
          ${ad.result && ad.result !== 'winner' && html`<span class=${'chip t-' + toneOf(ad.result)}>${(R.RESULTS[ad.result] || {}).label || ad.result}</span>`}
          ${era && html`<span class=${'chip t-' + (ad.setup_era === 'era1' ? 'mid' : 'muted')} title=${era.note}>${era.label}</span>`}
          ${hist.oldPage && ad.setup_era !== 'era1' && html`<span class="chip t-mid">Old landing page</span>`}
          ${ad.launched_on && html`<span class="chip t-muted">Live ${ad.launched_on}</span>`}
        </div>
        ${ad.setup_era === 'era1' && html`<div class="status warn small">${R.ERAS.era1.note}</div>`}
        ${ad.stage === 'main' && (() => { const f = fatigueSignals(data, product).find((x) => x.ad.id === ad.id); return f && html`<div class="status warn small"><b>May be fatiguing.</b> ${fatigueText(f)}</div>`; })()}
        ${(() => { const rows = rowsForAd(ad, data.meta_days); if (!rows.length) return null; const t = sumRows(rows.filter((r) => r.day >= R.addDays(R.today(), -7))), all = sumRows(rows);
          return html`<div class="panel"><h2>From your Ads Manager files</h2><div class="metrics">
            <div class="metric"><small>Last 7 days</small><b>${R.money0(t.spend)}</b></div><div class="metric"><small>7d ROAS</small><b>${R.xroas(t.roas)}</b></div><div class="metric"><small>7d CPA</small><b>${R.money(t.cpa)}</b></div>
            <div class="metric"><small>All files</small><b>${R.money0(all.spend)}</b></div><div class="metric"><small>ROAS</small><b>${R.xroas(all.roas)}</b></div><div class="metric"><small>Buys</small><b>${Math.round(all.purchases)}</b></div></div></div>`; })()}
        ${actions.length > 0 && html`<div class="row">${actions}</div>`}
        <div class="row"><label class="f" style="flex-direction:row;align-items:center;gap:8px">Move to
          <select class="inp" style="width:auto;min-height:36px" value=${ad.stage} onChange=${(e) => move(e.target.value, 'Moved by hand')}>
            ${[...R.STAGES, ...R.SHELVES].map((s) => html`<option value=${s.key}>${s.label}</option>`)}</select></label></div>
        ${(ad.headline || ad.primary_text || ad.angle || ad.offer || ad.notes) && html`<div class="panel">
          ${ad.angle && html`<div class="small"><span class="muted">Angle:</span> ${ad.angle}</div>`}
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

function TestPanel({ data, test, rules, econ, setModal }) {
  const cps = data.checkpoints.filter((c) => c.test_id === test.id).sort((a, b) => a.day - b.day);
  const st = R.testStatus(test, cps, rules, econ.aov);
  const m = st.m, dg = R.diagnose(m);
  const be = R.breakEven(econ);
  const c = test.conditions || {};
  return html`<div class=${'panel' + (test.status === 'active' ? ' accent' : '')}>
    <div class="row"><h2>${test.stage === 2 ? 'Stage 2 · Main' : 'Stage 1 test'}</h2><span class="spacer"></span>
      <span class="muted small">${test.start_date ? 'Started ' + test.start_date : ''}${test.budget ? ' · $' + test.budget + '/day' : ''}</span></div>
    ${test.status === 'active' && test.stage === 1 && html`<div class=${'status ' + (st.final ? 'good' : st.early ? 'bad' : st.behind ? 'warn' : 'live')}>${st.text}</div>`}
    ${test.status !== 'active' && test.result && html`<div class=${'status ' + (toneOf(test.result) === 'pass' ? 'good' : toneOf(test.result) === 'fail' ? 'bad' : 'warn')}><b>${(R.RESULTS[test.result] || {}).label || test.result}</b>${test.result_reason ? ' · ' + test.result_reason : ''}${test.override_reason ? html`<br/><span class="small">Your call: ${test.override_reason}</span>` : ''}</div>`}
    ${m && html`<div class="metrics">
      <div class="metric"><small>Spend</small><b>${R.money(m.spend)}</b></div><div class="metric"><small>Buys</small><b>${m.purchases}</b></div>
      <div class=${'metric ' + (m.cpa != null ? (m.cpa <= rules.passACpa ? 'good' : 'bad') : '')}><small>CPA</small><b>${R.money(m.cpa)}</b></div>
      <div class=${'metric ' + (m.roas != null ? (m.roas >= (be.roas || rules.passARoas) ? 'good' : m.roas < rules.failRoas ? 'bad' : '') : '')}><small>ROAS${m.revenueEstimated ? '*' : ''}</small><b>${R.xroas(m.roas)}</b></div>
      <div class="metric"><small>Avg order</small><b>${R.money(m.aov)}</b></div><div class="metric"><small>CTR</small><b>${R.pct(m.ctr)}</b></div>
      ${m.hookRate != null && html`<div class="metric"><small>Hook rate</small><b>${R.pct(m.hookRate)}</b></div>`}<div class="metric"><small>Freq</small><b>${m.frequency ?? '—'}</b></div></div>`}
    ${m && m.aov != null && m.aov < econ.aov * 0.9 && html`<div class="status warn">Orders on this ad average ${R.money(m.aov)}, under your ${R.money(econ.aov)} average. The offer may be pulling order size down.</div>`}
    ${dg && dg.steps.length > 0 && html`<div class="stack" style="gap:6px">${dg.steps.map((s) => html`<div class="meter"><span>${s.label}</span><span class="trk"><i style=${`width:${Math.min(100, s.value * (s.key === 'stop' ? 30 : s.key === 'cart' ? 3 : 1.6))}%;background:${s.ok ? 'var(--pass)' : 'var(--mid)'}`}></i></span><span class="mono" style="text-align:right">${s.value.toFixed(1)}%</span></div>`)}
      ${dg.advice && html`<span class="small" style="color:var(--mid)">${dg.advice}</span>`}</div>`}
    ${cps.length > 0 && html`<div class="tscroll"><table class="t"><thead><tr><th>Check-in</th><th>Spend</th><th>Buys</th><th>CPA</th><th>ROAS</th><th>CTR</th><th></th></tr></thead><tbody>
      ${cps.map((cp) => { const mm = R.metrics(cp, econ.aov); return html`<tr><td>Day ${cp.day}</td><td>${R.money(mm.spend)}</td><td>${mm.purchases}</td><td>${R.money(mm.cpa)}</td><td>${R.xroas(mm.roas)}</td><td>${R.pct(mm.ctr)}</td><td>${test.status === 'active' && html`<button class="link small" onClick=${() => setModal({ type: CheckinForm, props: { adId: test.ad_id, testId: test.id, day: cp.day } })}>Edit</button>`}</td></tr>`; })}
    </tbody></table></div>`}
    ${(c.landingPage || c.enhancements != null || c.method) && html`<div class="tiny muted">Conditions: ${[c.method, c.landingPage, c.enhancements ? 'creative enhancements ON' : c.enhancements === false ? 'enhancements off' : null, c.shopAds ? 'Shop ads ON' : null, c.emergency ? 'emergency, no test' : null].filter(Boolean).join(' · ')}</div>`}
  </div>`;
}

// ---------- forms ----------
function AdForm(ctx) {
  const { data, product, mode, adId, recycle, close, reload, say, setModal } = ctx;
  const src = adId ? data.ads.find((a) => a.id === adId) : null;
  const bumpV = (n) => /V\d+\s*$/i.test(n) ? n.replace(/V(\d+)\s*$/i, (_, d) => 'V' + (+d + 1)) : n + ' | V2';
  const init = mode === 'new' ? { base_name: `IMG | ${product.name.split(' ')[0]} | | V1`, format: 'image', angle: '', offer: '$6 per shirt · 6 for $36 · Free shipping', headline: '', primary_text: '', notes: '', concept: '' }
    : { ...src, base_name: mode === 'version' ? bumpV(src.base_name) : src.base_name, notes: mode === 'version' ? (recycle ? 'Recycled. The fix: ' : 'What changed: ') : src.notes };
  const [f, setF] = useState(init); const [file, setFile] = useState(null); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const cs = conceptStats(data, f.concept);
  const save = async () => {
    if (!f.base_name.trim()) { say('Give the ad a name.'); return; }
    setBusy(true);
    try {
      const pidUse = src ? src.product_id : product.id;
      let media_path = mode === 'new' ? null : src.media_path, media_type = mode === 'new' ? null : src.media_type;
      if (file) { media_path = await be.upload(`${pidUse}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${extOf(file)}`, file); media_type = file.type; }
      const row = { base_name: f.base_name.trim(), format: f.format, angle: f.angle, offer: f.offer, headline: f.headline, primary_text: f.primary_text, notes: f.notes, concept: f.concept || null, media_path, media_type };
      if (mode === 'edit') { await be.update('ads', src.id, row); await reload(); close(); say('Saved'); return; }
      const ins = await be.insert('ads', { ...row, product_id: pidUse, stage: 'untested', version: mode === 'version' ? (src.version || 1) + 1 : 1, parent_id: mode === 'version' ? src.id : null, tags: {}, history: {} });
      await reload(); say(mode === 'version' ? 'New version added to Ideas' : 'Added to Ideas');
      setModal({ type: AdDetail, props: { adId: ins.id } });
    } catch (e) { say('Could not save: ' + e.message); }
    setBusy(false);
  };
  return html`<${Modal} title=${mode === 'new' ? 'New ad' : mode === 'edit' ? 'Edit ad' : recycle ? 'Recycle with a fix' : 'New version'} sub=${mode === 'new' ? product.name : src.base_name} onClose=${close}>
    <div class="form">
      <${Field} full label="Name, exactly as in Ads Manager (the launch date is added for you)"><input value=${f.base_name} onInput=${set('base_name')} /><//>
      <${Field} label="Image or video">
        <input type="file" accept="image/*,video/*" onChange=${(e) => setFile(e.target.files[0] || null)} /><//>
      <${Field} label="Format"><select value=${f.format} onChange=${set('format')}><option value="image">Image</option><option value="video">Video</option><option value="carousel">Carousel</option></select><//>
      <${Field} label="Concept (same footage or shot = same concept)"><input list="concept-list-form" value=${f.concept || ''} onInput=${set('concept')} placeholder="Display walkthrough" /><datalist id="concept-list-form">${allConcepts(data).map((c) => html`<option value=${c} />`)}</datalist><//>
      ${cs && cs.fam.length >= 3 && html`<div class="status warn small full">This concept has ${cs.fam.length} versions already${cs.counted ? `; ${cs.won} of ${cs.counted} worked since Era 1` : ''}. Change something real, not just the text.</div>`}
      <${Field} label="Angle"><input list="angle-list-form" value=${f.angle || ''} onInput=${set('angle')} placeholder="$6 per shirt" /><datalist id="angle-list-form">${allAngles(data).map((c) => html`<option value=${c} />`)}</datalist><//>
      ${allAngles(data).length > 0 && html`<div class="pickrow full"><span class="tiny muted">Tap an angle:</span>${allAngles(data).map((c) => html`<button type="button" class=${'pick' + (f.angle === c ? ' on' : '')} onClick=${() => setF({ ...f, angle: c })}>${c}</button>`)}</div>`}
      <${Field} full label="Offer"><input value=${f.offer || ''} onInput=${set('offer')} /><//>
      <${Field} full label="Headline"><input value=${f.headline || ''} onInput=${set('headline')} /><//>
      <${Field} full label="Primary text"><textarea value=${f.primary_text || ''} onInput=${set('primary_text')}></textarea><//>
      <${Field} full label="Notes"><textarea value=${f.notes || ''} onInput=${set('notes')}></textarea><//>
    </div>
    <div class="row"><button class="btn primary" disabled=${busy} onClick=${save}>${busy ? 'Saving…' : 'Save'}</button><button class="btn ghost" onClick=${close}>Cancel</button></div>
  <//>`;
}

function LaunchForm(ctx) {
  const { data, adId, close, reload, say } = ctx;
  const ad = data.ads.find((a) => a.id === adId); const product = data.products.find((p) => p.id === ad.product_id);
  const rules = R.rulesOf(product);
  const live = data.tests.filter((t) => t.status === 'active' && t.stage === 1);
  const spendLive = live.reduce((s, t) => s + (+t.budget || 0), 0);
  const [f, setF] = useState({ date: R.today(), budget: rules.stage1Budget, days: rules.plannedDays, method: R.TEST_METHODS[0], landingPage: 'Current page (Mar 2026+)', enhancements: false, shopAds: false });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const warns = [];
  if (live.length >= rules.slots) warns.push(`${live.length} Stage 1 tests are already live (your limit is ${rules.slots}).`);
  if (spendLive + (+f.budget || 0) > rules.testingCap) warns.push(`Testing spend would be $${spendLive + (+f.budget || 0)}/day, over your $${rules.testingCap} cap.`);
  if (rules.weekendLock && R.isWeekendLock()) warns.push('Weekend lock is on (Friday night to Sunday).');
  if (f.enhancements) warns.push('Creative enhancements ON: Meta will change your ad, so the result says less about your creative.');
  const go = async () => {
    await be.insert('tests', { ad_id: ad.id, product_id: ad.product_id, stage: 1, start_date: f.date, planned_days: +f.days || rules.plannedDays, budget: +f.budget || null, status: 'active', conditions: { method: f.method, landingPage: f.landingPage, enhancements: f.enhancements, shopAds: f.shopAds } });
    await be.update('ads', ad.id, { stage: 'testing', launched_on: f.date, setup_era: R.eraOf(f.date), tags: { ...(ad.tags || {}), ready: false } });
    await be.insert('decisions', { product_id: ad.product_id, ad_id: ad.id, kind: 'launch', choice: `Launched at $${f.budget}/day`, day: f.date });
    await reload(); close(); say('Test started. Name now shows the launch date.');
  };
  return html`<${Modal} title="It went live in Meta" sub=${ad.base_name} onClose=${close}>
    ${warns.length > 0 && html`<div class="banner"><ul style="margin:0;padding-left:18px">${warns.map((w) => html`<li>${w}</li>`)}</ul></div>`}
    <div class="form">
      <${Field} label="First day it spent money"><input type="date" value=${f.date} onInput=${set('date')} /><//>
      <${Field} label="Budget ($/day)"><input inputmode="decimal" value=${f.budget} onInput=${set('budget')} /><//>
      <${Field} label="Test window (days)"><input inputmode="numeric" value=${f.days} onInput=${set('days')} /><//>
      <${Field} label="How you're testing it"><select value=${f.method} onChange=${set('method')}>${R.TEST_METHODS.filter((m) => !m.startsWith('Straight')).map((m) => html`<option>${m}</option>`)}</select><//>
      <${Field} full label="Landing page"><input value=${f.landingPage} onInput=${set('landingPage')} /><//>
      <label class="chk full"><input type="checkbox" checked=${f.enhancements} onChange=${set('enhancements')} /> Advantage+ creative enhancements on</label>
      <label class="chk full"><input type="checkbox" checked=${f.shopAds} onChange=${set('shopAds')} /> Shop ads on</label>
    </div>
    <div class="row"><button class="btn primary" onClick=${go}>Start test</button><button class="btn ghost" onClick=${close}>Cancel</button></div>
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
    <div class="form">
      <${Field} label="Day"><input inputmode="numeric" value=${f.day} onInput=${set('day')} disabled=${!!existing} /><//>
      ${fields.map(([k, l]) => html`<${Field} label=${l}><input inputmode="decimal" value=${f[k]} onInput=${set(k)} /><//>`)}
      ${isFinal && html`<${Field} label=${`Purchases in the last ${rules.collapseDays} days`}><input inputmode="numeric" value=${f.last3_purchases} onInput=${set('last3_purchases')} /><//>`}
      <${Field} full label="Notes"><input value=${f.notes} onInput=${set('notes')} /><//>
    </div>
    <div class="row"><button class="btn primary" onClick=${save}>Save results</button><button class="btn ghost" onClick=${close}>Cancel</button></div>
  <//>`;
}

function FinalizeForm(ctx) {
  const { data, testId, close, reload, say } = ctx;
  const test = data.tests.find((t) => t.id === testId); const product = data.products.find((p) => p.id === test.product_id);
  const rules = R.rulesOf(product), econ = R.econOf(product);
  const cps = data.checkpoints.filter((c) => c.test_id === test.id).sort((a, b) => a.day - b.day);
  const last = cps[cps.length - 1]; const m = last ? R.metrics(last, econ.aov) : null;
  const c = R.classify(m, rules, last);
  const early = last && last.day < (test.planned_days || rules.plannedDays);
  const [pick, setPick] = useState(c.result || 'insufficient'); const [why, setWhy] = useState('');
  const events = data.events.filter((e) => (!e.product_id || e.product_id === test.product_id) && test.start_date && e.day >= test.start_date && e.day <= R.addDays(test.start_date, test.planned_days || 7));
  const go = async () => {
    if (pick !== c.result && !why.trim()) { say('Add a reason when you change the result.'); return; }
    const strong = pick === 'strong_pass';
    await be.update('tests', test.id, { status: 'complete', result: pick, strong, result_reason: c.evidence.join(' '), override_reason: pick !== c.result ? why : null });
    const fad = data.ads.find((a) => a.id === test.ad_id) || {};
    await be.update('ads', test.ad_id, { stage: R.stageForResult(pick), result: pick, tags: { ...(fad.tags || {}), retest: R.isRetestResult(pick), ready: false } });
    await be.insert('decisions', { product_id: test.product_id, ad_id: test.ad_id, test_id: test.id, kind: 'result', choice: `Filed as ${R.RESULTS[pick].label}`, reason: why });
    await reload(); close(); say('Filed in ' + R.stageLabel(R.stageForResult(pick)));
  };
  return html`<${Modal} title="Finalize the test" onClose=${close}>
    ${early && html`<div class="banner">The planned window isn't finished (last check-in was day ${last.day}). Finalizing now is your call.</div>`}
    ${!m && html`<div class="banner">No numbers yet. Add results first.</div>`}
    ${m && html`<div class="status ${toneOf(c.result) === 'pass' ? 'good' : toneOf(c.result) === 'fail' ? 'bad' : 'warn'}"><b>Your rules say: ${R.RESULTS[c.result].label}</b><ul style="margin:6px 0 0;padding-left:18px">${c.evidence.map((x) => html`<li>${x}</li>`)}</ul><div class="small" style="margin-top:6px">Files into: <b>${R.stageLabel(R.stageForResult(pick))}</b></div></div>`}
    ${events.length > 0 && html`<div class="banner">Changes logged during this test: ${events.map((e) => `${e.day} ${e.kind}`).join('; ')}. If they distorted it, file it as "Not a fair test".</div>`}
    <div class="form">
      <${Field} label="File it as"><select value=${pick} onChange=${(e) => setPick(e.target.value)}>${Object.entries(R.RESULTS).filter(([, v]) => !v.main).map(([k, v]) => html`<option value=${k}>${v.label}${k === c.result ? ' (your rules)' : ''}</option>`)}</select><//>
      <${Field} full label="Reason, if you change it"><input value=${why} onInput=${(e) => setWhy(e.target.value)} /><//>
    </div>
    <div class="row"><button class="btn primary" onClick=${go}>File result</button><button class="btn ghost" onClick=${close}>Not yet</button></div>
  <//>`;
}

function StopForm(ctx) {
  const { data, testId, close, reload, say } = ctx;
  const test = data.tests.find((t) => t.id === testId);
  const [why, setWhy] = useState('early'); const [note, setNote] = useState('');
  const go = async () => {
    const result = why === 'early' ? 'fail' : 'unfair';
    await be.update('tests', test.id, { status: 'stopped', result, result_reason: why === 'early' ? 'Stopped by the early-stop rule.' : 'Stopped: ' + (note || 'outside problem'), override_reason: note || null });
    const sad = data.ads.find((a) => a.id === test.ad_id) || {};
    await be.update('ads', test.ad_id, { stage: R.stageForResult(result), result, tags: { ...(sad.tags || {}), retest: R.isRetestResult(result), ready: false } });
    await be.insert('decisions', { product_id: test.product_id, ad_id: test.ad_id, test_id: test.id, kind: 'kill', choice: 'Stopped early', reason: note });
    await reload(); close(); say('Stopped and filed');
  };
  return html`<${Modal} title="Stop early" onClose=${close}>
    <div class="form">
      <${Field} full label="Why"><select value=${why} onChange=${(e) => setWhy(e.target.value)}><option value="early">Early-stop rule (files as Fail)</option><option value="outside">Stock, site, tracking or Meta problem (files as Not a fair test)</option></select><//>
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
  const go = async () => { if (!name.trim()) return; await be.insert('products', { name: name.trim(), kind, sort: data.products.length + 1, rules: crew ? crew.rules || {} : {}, economics: crew ? crew.economics || {} : {} }); await reload(); close(); say('Product added. Set its costs in Rules.'); };
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
    const st = R.testStatus(t, data.checkpoints.filter((c) => c.test_id === t.id), rules, R.econOf(p).aov);
    if (st.early) items.push({ tone: 'red', title: `Early-stop rule met: ${ad.base_name}`, sub: st.text, tag: 'DECIDE', go: () => setModal({ type: AdDetail, props: { adId: ad.id } }) });
    if (st.final) items.push({ tone: 'blue', title: `Finalize: ${displayName(ad)}`, sub: `${p.name} · window complete`, tag: 'TODAY', go: () => setModal({ type: FinalizeForm, props: { testId: t.id } }) });
    else if (st.due.length) items.push({ tone: 'amber', title: `Day ${st.due[st.due.length - 1]} results: ${displayName(ad)}`, sub: `${p.name} · day ${st.day} of ${st.planned}`, tag: 'DUE', go: () => setModal({ type: CheckinForm, props: { testId: t.id } }) });
  }
  for (const p of products) {
    const bh = benchHealth(data, p);
    if (bh.urgent) items.unshift({ tone: 'red', title: `${p.name}: Bench is ${bh.bench ? 'low' : 'empty'} and Main is fatiguing`, sub: `${bh.fatiguing.map((a) => a.base_name).join(', ')} fatiguing. ${bh.bench} of ${bh.target} tested backups ready. Test now so September doesn't repeat.`, tag: 'ACT', go: () => { setPid(p.id); setView('board'); } });
    else if (bh.low && bh.main) items.push({ tone: 'amber', title: `${p.name}: Bench under target`, sub: `${bh.bench} of ${bh.target} tested backups ready.`, tag: 'PLAN', go: () => { setPid(p.id); setView('board'); } });
  }
  for (const p of products) for (const f of fatigueSignals(data, p)) {
    if (f.ad.tags && f.ad.tags.fatiguing) continue;
    items.unshift({ tone: 'amber', title: `${f.ad.base_name} may be fatiguing`, sub: fatigueText(f) + ' Open it and mark it fatiguing if you agree.', tag: 'CHECK', go: () => setModal({ type: AdDetail, props: { adId: f.ad.id } }) });
  }
  const lastMeta = data.meta_days.reduce((m, r) => (r.day > m ? r.day : m), '');
  if (!lastMeta || lastMeta < R.addDays(R.today(), -1)) items.push({ tone: 'blue', title: lastMeta ? `Add yesterday's Ads Manager file (last one: ${lastMeta})` : 'Add your first Ads Manager file', sub: 'Keeps check-ins, fatigue warnings and Stats up to date.', tag: 'DAILY', go: () => setView('stats') });
  const ready = data.ads.filter((a) => a.stage === 'untested' && a.tags && a.tags.ready);
  const live = data.tests.filter((t) => t.status === 'active' && t.stage === 1).length;
  const rules0 = R.rulesOf(products[0]);
  const running = data.tests.filter((t) => t.status === 'active');
  return html`
    <div class="row"><div class="stack" style="gap:0"><span class="small" style="color:var(--accent2);letter-spacing:.16em;font-weight:600">${new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()}</span><h1 style="font-size:34px">Today</h1></div></div>
    <section class="panel"><h2>Due</h2>
      ${items.length ? html`<div class="list">${items.map((it) => html`<button class="li" style="background:none;border-left:0;border-right:0;border-bottom:0;color:inherit;text-align:left;cursor:pointer;width:100%" onClick=${it.go}><span class=${'bar ' + it.tone}></span><span class="grow"><b>${it.title}</b><br/><span class="small muted">${it.sub}</span></span><span class="mono tiny" style="color:var(--accent2)">${it.tag}</span></button>`)}</div>`
        : html`<div class="empty">Nothing due. ${running.length ? `${running.length} test${running.length > 1 ? 's' : ''} running.` : 'No tests running.'}</div>`}
    </section>
    ${ready.length > 0 && live < rules0.slots && html`<section class="panel"><h2>Slot open</h2><div class="small">${rules0.slots - live} test slot${rules0.slots - live > 1 ? 's' : ''} free. Ready to launch:</div>
      <div class="list">${ready.map((a) => html`<button class="li" style="background:none;border-left:0;border-right:0;border-bottom:0;color:inherit;text-align:left;cursor:pointer;width:100%" onClick=${() => setModal({ type: AdDetail, props: { adId: a.id } })}><${Media} path=${a.media_path} type=${a.media_type} cls="" /><span class="grow small"><b>${a.base_name}</b><br/><span class="muted">${(products.find((p) => p.id === a.product_id) || {}).name}</span></span></button>`)}</div></section>`}
    <section class="panel"><h2>Running</h2>
      ${running.length ? html`<div class="list">${running.map((t) => { const ad = data.ads.find((a) => a.id === t.ad_id); return ad && html`<button class="li" style="background:none;border-left:0;border-right:0;border-bottom:0;color:inherit;text-align:left;cursor:pointer;width:100%" onClick=${() => setModal({ type: AdDetail, props: { adId: ad.id } })}><span class="bar blue"></span><span class="grow small"><b>${displayName(ad)}</b><br/><span class="muted">${t.stage === 2 ? 'Trial in Main' : 'Stage 1'} · day ${R.testDay(t)}</span></span></button>`; })}</div>` : html`<div class="empty">No live tests</div>`}
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
  ['open', 'Untested or retest', 'live', () => true],
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

function QuickSet({ list, field, data, reload, say }) {
  const opts = field === 'angle' ? allAngles(data) : allConcepts(data);
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
  if (cs && cs.fam.length >= 5) { max += 10; fixes.push({ size: 'big', text: `This concept has ${cs.fam.length} versions${cs.counted ? ` and ${cs.won} of ${cs.counted} worked since Era 1` : ''}. Change the hook, first frame or offer, not just the text.` }); }
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
    await be.update('ads', ad.id, { tags: { ...(ad.tags || {}), review: { answers: ans, score: r.score, verdict: r.verdict, day: R.today() }, ...(markReady ? { ready: true } : {}) } });
    await reload(); close(); say(markReady ? 'Scored and marked ready' : 'Check saved');
  };
  const tone = r.score >= 80 ? 'good' : r.score >= 60 ? 'warn' : 'bad';
  return html`<${Modal} title="Pre-launch check" sub=${ad.base_name} onClose=${close}>
    <p class="small muted" style="margin:0">Scored against what has won and lost in your own ads. The AI review that looks at the image itself comes later.</p>
    <div class="stack" style="gap:8px">${r.list.map((c) => html`<div class="qrow"><span class="small">${c.q}</span>
      <span class="seg sm">${['yes', 'no', 'unsure'].map((v) => html`<button class=${ans[c.k] === v ? 'on' : ''} onClick=${() => setAns({ ...ans, [c.k]: v })}>${v === 'unsure' ? 'Not sure' : v[0].toUpperCase() + v.slice(1)}</button>`)}</span></div>`)}</div>
    <div class=${'status ' + tone}><b>${r.score}/100 · ${r.done ? r.verdict : 'Answer every question'}</b>
      ${r.fixes.length > 0 && html`${['big', 'small'].map((sz) => r.fixes.filter((f) => f.size === sz).length > 0 && html`<div class="small" style="margin-top:6px"><b>${sz === 'big' ? 'Big changes' : 'Small changes'}</b><ul style="margin:4px 0 0;padding-left:18px">${r.fixes.filter((f) => f.size === sz).map((f) => html`<li>${f.text}</li>`)}</ul></div>`)}`}</div>
    <div class="row"><button class="btn primary" disabled=${!r.done} onClick=${() => save(r.score >= 80)}>${r.score >= 80 ? 'Save and mark ready' : 'Save'}</button><button class="btn ghost" onClick=${close}>Cancel</button></div>
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
    const rows = rowsForAd(ad, data.meta_days).filter((r) => r.day >= t.start_date);
    if (!rows.length) continue;
    const maxDay = rows.map((r) => r.day).sort().pop();
    const want = [...new Set([...R.checkinDays(rules).map((d) => Math.min(d, planned)), planned])];
    for (const d of want) {
      const end = R.addDays(t.start_date, d - 1);
      if (maxDay < end) continue;
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

// Main ads whose last 7 days look worse than the 7 before. A suggestion only: you decide.
function fatigueSignals(data, product) {
  const md = data.meta_days; if (!md.length) return [];
  const rules = R.rulesOf(product);
  const last = md.reduce((m, r) => (r.day > m ? r.day : m), '');
  const a = R.addDays(last, -6), b = R.addDays(last, -13), be7 = R.addDays(last, -7);
  return data.ads.filter((x) => x.product_id === product.id && x.stage === 'main').map((ad) => {
    const rows = rowsForAd(ad, md);
    const now = sumRows(rows.filter((r) => r.day >= a)), prev = sumRows(rows.filter((r) => r.day >= b && r.day <= be7));
    if (now.spend < rules.fatigueMinSpend || prev.spend < rules.fatigueMinSpend) return null;
    const cpaUp = now.cpa && prev.cpa ? (now.cpa / prev.cpa - 1) * 100 : now.purchases === 0 ? 100 : 0;
    const roasDown = prev.roas ? (1 - (now.roas || 0) / prev.roas) * 100 : 0;
    if (cpaUp >= rules.fatigueCpaUp || roasDown >= rules.fatigueRoasDown) return { ad, now, prev, cpaUp, roasDown, last };
    return null;
  }).filter(Boolean);
}
const fatigueText = (f) => `CPA ${R.money(f.prev.cpa)} → ${R.money(f.now.cpa)}, ROAS ${R.xroas(f.prev.roas)} → ${R.xroas(f.now.roas)} (last 7 days vs the 7 before)${f.now.frequency ? `, frequency ${f.now.frequency.toFixed(1)}` : ''}.`;

function MetaDrop({ data, reload, say, compact }) {
  const [st, setSt] = useState(null);
  const last = data.meta_days.reduce((m, r) => (r.day > m ? r.day : m), '');
  const go = async (file) => {
    if (!file) return;
    setSt({ msg: 'Reading ' + file.name + '…' });
    try {
      const f = await readMetaFile(file);
      setSt({ msg: `Saving ${f.rows.length} rows…` });
      await be.upsert('meta_days', f.rows.map((r) => ({ ...r, imported_at: new Date().toISOString() })));
      const fresh = await be.loadAll(); fresh.ads = fresh.ads.map(R.normalizeAd);
      const filled = await autoCheckins(fresh);
      const known = new Set(fresh.ads.map((a) => normName(a.base_name)));
      const unmatched = [...new Set(f.rows.filter((r) => r.spend > 0 && !known.has(normName(r.ad_name))).map((r) => r.ad_name))];
      await reload();
      setSt({ ok: true, msg: `Added ${f.days.length === 1 ? f.days[0] : f.days[0] + ' to ' + f.days[f.days.length - 1]}: ${f.rows.length} ad rows, ${R.money0(f.spend)} spend.`
        + (filled.length ? ` Filled check-ins: ${filled.join(', ')}.` : '') + (f.ranged ? ` Skipped ${f.ranged} rows that covered several days.` : ''), unmatched });
      say('Ads Manager file added');
    } catch (e) { setSt({ err: true, msg: e.message }); }
  };
  return html`<div class=${'drop' + (compact ? ' compact' : '')}>
    <label class="btn primary"><input type="file" accept=".csv,.xlsx,.xls" hidden onChange=${(e) => { go(e.target.files[0]); e.target.value = ''; }} />Add Ads Manager file</label>
    <span class="small muted">${last ? `Meta numbers through ${last}.` : 'No Meta numbers yet.'} Export the Ads tab for yesterday (or with Breakdown → Day), CSV or Excel.</span>
    ${st && html`<div class=${'status small ' + (st.err ? 'bad' : st.ok ? 'good' : 'live')}>${st.msg}
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
    ${st && html`<div class=${'status small ' + (st.err ? 'bad' : st.ok ? 'good' : 'live')}>${st.msg}</div>`}
  </div>`;
}

// Line chart: one money axis, hover crosshair + tooltip.
function LineChart({ labels, series, fmt, refLine, height = 190 }) {
  const [hi, setHi] = useState(null);
  const W = 720, H = height, L = 48, Rt = 10, T = 12, B = 24;
  const vals = series.flatMap((s) => s.values.filter((v) => v != null));
  if (refLine) vals.push(refLine.value);
  const max = Math.max(1e-9, ...vals) * 1.1;
  const x = (i) => L + (labels.length <= 1 ? 0 : i * (W - L - Rt) / (labels.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => max / 1.1 * f);
  const step = Math.max(1, Math.ceil(labels.length / 7));
  const move = (e) => { const r = e.currentTarget.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * W; const i = Math.round((px - L) / ((W - L - Rt) / Math.max(1, labels.length - 1))); setHi(Math.max(0, Math.min(labels.length - 1, i))); };
  return html`<div class="chart">
    <svg viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove=${move} onMouseLeave=${() => setHi(null)} role="img">
      ${ticks.map((t) => html`<line x1=${L} x2=${W - Rt} y1=${y(t)} y2=${y(t)} class="grid" /><text x=${L - 6} y=${y(t) + 4} class="ax" text-anchor="end">${fmt(t, true)}</text>`)}
      ${labels.map((l, i) => i % step === 0 && html`<text x=${x(i)} y=${H - 6} class="ax" text-anchor="middle">${R.shortDate(l)}</text>`)}
      ${refLine && html`<line x1=${L} x2=${W - Rt} y1=${y(refLine.value)} y2=${y(refLine.value)} class="ref" /><text x=${W - Rt} y=${y(refLine.value) - 5} class="ax" text-anchor="end">${refLine.label}</text>`}
      ${series.map((s) => { const pts = s.values.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' '); return html`<polyline points=${pts} fill="none" stroke=${s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />`; })}
      ${hi != null && html`<line x1=${x(hi)} x2=${x(hi)} y1=${T} y2=${H - B} class="cross" />${series.map((s) => s.values[hi] != null && html`<circle cx=${x(hi)} cy=${y(s.values[hi])} r="4" fill=${s.color} stroke="var(--panel)" stroke-width="2" vector-effect="non-scaling-stroke" />`)}`}
    </svg>
    ${series.length > 1 && html`<div class="legend">${series.map((s) => html`<span><i style=${'background:' + s.color}></i>${s.name}</span>`)}</div>`}
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
  const flat = econ.costs.filter((c) => !c.pct).reduce((s, c) => s + (R.num(c.value) || 0), 0);
  const pct = econ.costs.filter((c) => c.pct).reduce((s, c) => s + (R.num(c.value) || 0), 0) / 100;
  const profit = shop.length ? revenue * (1 - pct) - (units || orders) * flat - m.spend : null;
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
  const econ = R.econOf(product), bev = R.breakEven(econ);
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
  const tone = (roas) => (roas == null ? '' : roas >= (bev.roas || 2.7) ? 'good' : roas < 2 ? 'bad' : '');
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
      <div class=${'tile ' + (cur.mer != null && cur.mer < (bev.roas || 0) ? 'warn' : '')}><div class="k">MER (blended ROAS)</div><div class="v">${R.xroas(cur.mer)}</div><div class="s">Break-even ${R.xroas(bev.roas)} · <${Delta} now=${cur.mer} prev=${prev.mer} /></div></div>
      <div class="tile"><div class="k">Profit (est.)</div><div class="v">${cur.profit == null ? '—' : R.money0(cur.profit)}</div><div class="s">After product, shipping, fees and ads</div></div>
      <div class="tile"><div class="k">Orders · AOV</div><div class="v">${cur.hasShop ? cur.orders : '—'} <small>· ${R.money(cur.aov)}</small></div><div class="s"><${Delta} now=${cur.orders} prev=${prev.orders} /> orders</div></div>
      <div class="tile"><div class="k">Meta ROAS · CPA</div><div class="v">${R.xroas(cur.roas)} <small>· ${R.money(cur.cpa)}</small></div><div class="s">${Math.round(cur.metaBuys)} Meta-reported buys</div></div>
    </section>
    <div class="grid2">
      <section class="panel"><h2>Revenue and ad spend</h2><${LineChart} labels=${labels} fmt=${(v, ax) => (ax ? '$' + Math.round(v) : R.money0(v))} series=${[{ name: 'Revenue (Shopify)', color: '#3D8BFF', values: revS }, { name: 'Ad spend (Meta)', color: '#C2669E', values: spS }]} /></section>
      <section class="panel"><h2>MER by day</h2><${LineChart} labels=${labels} fmt=${(v) => v.toFixed(2) + 'x'} refLine=${bev.roas ? { value: bev.roas, label: 'Break-even ' + R.xroas(bev.roas) } : null} series=${[{ name: 'MER', color: '#3D8BFF', values: merS }]} /></section>
    </div>
    <section class="panel">
      <div class="row"><h2>Breakdown</h2><span class="spacer"></span><div class="seg wide">${[['ads', 'By ad'], ['angle', 'By angle'], ['camp', 'By campaign']].map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div></div>
      ${!inRange.length ? html`<div class="empty">No Meta rows in this range.</div>` : html`<div class="tscroll"><table class="t stats">
        <thead><tr><th>${tab === 'ads' ? 'Ad' : tab === 'angle' ? 'Angle' : 'Campaign'}</th><th>Spend</th><th>Buys</th><th>ROAS</th><th>CPA</th><th>CTR</th><th>Freq</th></tr></thead>
        <tbody>${(tab === 'ads' ? shown.map((r) => ({ k: r.name, t: r.t, ad: r.ad })) : tab === 'angle' ? angleRows : campRows).map((r) => html`<tr class=${r.ad ? 'click' : ''} onClick=${() => r.ad && setModal({ type: AdDetail, props: { adId: r.ad.id } })}>
          <td><span class="cellname">${r.ad && html`<${Media} path=${r.ad.media_path} type=${r.ad.media_type} />`}<span>${r.k}${r.ad ? html`<br/><span class="tiny muted">${R.stageLabel(r.ad.stage)}${r.ad.angle ? ' · ' + r.ad.angle : ''}</span>` : ''}</span></span></td>
          <td>${R.money0(r.t.spend)}</td><td>${Math.round(r.t.purchases)}</td><td class=${tone(r.t.roas)}>${R.xroas(r.t.roas)}</td><td>${R.money(r.t.cpa)}</td><td>${R.pct(r.t.ctr)}</td><td>${r.t.frequency ? r.t.frequency.toFixed(1) : '—'}</td></tr>`)}</tbody></table></div>
        ${tab === 'ads' && adRows.length > 10 && html`<button class="link small" onClick=${() => setAll(!all)}>${all ? 'Show top 10' : `Show all ${adRows.length}`}</button>`}`}
      <p class="tiny muted" style="margin:0">ROAS and buys here are what Meta reports. MER uses real Shopify revenue. Profit uses ${product.name}'s cost lines per pack sold.</p>
    </section>`}`;
}

// ---------- rules ----------
const RULE_ROWS = [
  ['Budgets', [['stage1Budget', 'Stage 1 budget per ad set', '$/day'], ['boostedBudget', 'Boosted budget', '$/day'], ['boostAt', 'Boost when 30-day blended ROAS is at least', 'x']]],
  ['Test window', [['plannedDays', 'Test window', 'days'], ['checkins', 'Check-in days', 'day']]],
  ['Pass, Mid, Fail', [['minPurchases', 'Minimum purchases', 'buys'], ['passARoas', 'Pass A: ROAS at least', 'x'], ['passACpa', 'Pass A: CPA at most', '$'], ['passBRoas', 'Pass B: ROAS at least', 'x'], ['passBCpa', 'Pass B: CPA at most', '$'], ['failRoas', 'Fail below ROAS', 'x'], ['strongPct', 'Strong pass: CPA at most', '% of line'], ['collapseDays', 'Back-half collapse window', 'days']]],
  ['Early stop', [['earlyDay', 'From day', 'day'], ['earlySpend', 'Spend at least', '$'], ['earlyMaxPurchases', 'Purchases at most', 'buys']]],
  ['Capacity & timing', [['slots', 'Test slots at once', 'slots'], ['testingCap', 'Testing cap, all products', '$/day'], ['stage2Min', 'Stage 2 minimum', 'days'], ['stage2Max', 'Stage 2 maximum', 'days'], ['raiseStep', 'Budget raise step', '%'], ['benchTarget', 'Tested backups to keep on the Bench', 'ads']]],
];

function Rules(ctx) {
  const { product, reload, say } = ctx;
  const [rules, setRules] = useState(() => { const r = R.rulesOf(product); const o = {}; Object.keys(r).forEach((k) => { o[k] = String(r[k]); }); o.weekendLock = !!r.weekendLock; return o; });
  const [econ, setEcon] = useState(() => { const e = R.econOf(product); return { ...e, aov: String(e.aov), beRoas: String(e.beRoas), costs: e.costs.map((c) => ({ ...c, value: String(c.value) })) }; });
  const [busy, setBusy] = useState(false);
  const bev = R.breakEven(econ);
  const setCost = (i, k, v) => setEcon({ ...econ, costs: econ.costs.map((c, j) => j === i ? { ...c, [k]: v } : c) });
  const save = async () => {
    setBusy(true);
    const old = R.rulesOf(product); const nr = {};
    Object.keys(R.DEFAULT_RULES).forEach((k) => { nr[k] = k === 'checkins' ? rules[k] : k === 'weekendLock' ? !!rules.weekendLock : (R.num(rules[k]) ?? R.DEFAULT_RULES[k]); });
    const ne = { mode: econ.mode, beRoas: R.num(econ.beRoas), aov: R.num(econ.aov), costs: econ.costs.filter((c) => c.label.trim()).map((c) => ({ label: c.label.trim(), value: R.num(c.value) || 0, pct: !!c.pct })) };
    const changes = Object.keys(nr).filter((k) => String(nr[k]) !== String(old[k])).map((k) => `${k}: ${old[k]} → ${nr[k]}`);
    const oe = R.econOf(product); if (String(oe.beRoas) !== String(ne.beRoas) || String(oe.aov) !== String(ne.aov) || oe.mode !== ne.mode) changes.push(`break-even: ${oe.mode} ${oe.beRoas}x @ $${oe.aov} → ${ne.mode} ${ne.beRoas}x @ $${ne.aov}`);
    try {
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
      <section class="panel accent"><h2>Break-even</h2>
        <div class="seg" role="group" aria-label="Break-even source">
          <button class=${econ.mode === 'own' ? 'on' : ''} onClick=${() => setEcon({ ...econ, mode: 'own' })}>Set my own</button>
          <button class=${econ.mode === 'costs' ? 'on' : ''} onClick=${() => setEcon({ ...econ, mode: 'costs' })}>From my costs</button></div>
        <div class="tiles"><div class="tile"><div class="k">Break-even ROAS</div><div class="v" style="color:var(--accent2)">${R.xroas(bev.roas)}</div></div><div class="tile"><div class="k">Break-even CPA</div><div class="v" style="color:var(--accent2)">${R.money(bev.cpa)}</div><div class="s">at your average order</div></div></div>
        <div class="rulerow"><label for="aov">Average order value</label><input id="aov" inputmode="decimal" value=${econ.aov} onInput=${(e) => setEcon({ ...econ, aov: e.target.value })} /><span class="tiny muted">$</span></div>
        ${econ.mode === 'own' && html`<div class="rulerow"><label for="beroas">My break-even ROAS</label><input id="beroas" inputmode="decimal" value=${econ.beRoas} onInput=${(e) => setEcon({ ...econ, beRoas: e.target.value })} /><span class="tiny muted">x</span></div>`}
        <div class="fsec">Costs per order</div>
        ${econ.costs.map((c, i) => html`<div class="rulerow"><input style="text-align:left;font-family:var(--body)" value=${c.label} onInput=${(e) => setCost(i, 'label', e.target.value)} aria-label="Cost name" /><input inputmode="decimal" value=${c.value} onInput=${(e) => setCost(i, 'value', e.target.value)} aria-label=${c.label + ' amount'} /><span class="row tiny muted" style="gap:4px"><button class="link tiny" onClick=${() => setCost(i, 'pct', !c.pct)}>${c.pct ? '%' : '$'}</button><button class="link tiny" style="color:var(--fail)" onClick=${() => setEcon({ ...econ, costs: econ.costs.filter((_, j) => j !== i) })} aria-label="Remove">✕</button></span></div>`)}
        <button class="btn sm ghost" style="align-self:flex-start" onClick=${() => setEcon({ ...econ, costs: [...econ.costs, { label: 'New cost', value: '0', pct: false }] })}>+ Add a cost line</button>
        <div class="status small">From these costs: ${R.money(bev.calc.cpa)} CPA, ${R.xroas(bev.calc.roas)} ROAS. Cost per order ${R.money(bev.calc.cost)}.</div>
      </section>
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
