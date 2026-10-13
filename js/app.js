import { h, render } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import htm from 'htm';
import { createBackend } from './data.js';
import * as R from './rules.js';
import { importHistory } from './importer.js';

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
  const reload = async () => { try { setData(await be.loadAll()); } catch (e) { say('Could not load: ' + e.message); } };

  useEffect(() => {
    if (!be.configured) { setSession(null); return; }
    be.session().then(setSession);
    be.onAuth((s) => setSession(s));
  }, []);
  useEffect(() => { if (session) reload(); }, [session]);
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
  const NAV = [['today', 'Today'], ['board', 'Board'], ['rules', 'Rules'], ['learn', 'Learnings'], ['more', 'More']];

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
      ${view !== 'more' && view !== 'today' && html`<${ProductTabs} ...${ctx} setPid=${setPid} />`}
      ${view === 'board' && html`<${Board} ...${ctx} stage=${stage} setStage=${setStage} />`}
      ${view === 'today' && html`<${Today} ...${ctx} setPid=${setPid} />`}
      ${view === 'rules' && html`<${Rules} key=${product.id} ...${ctx} />`}
      ${view === 'learn' && html`<${Learn} ...${ctx} />`}
      ${view === 'more' && html`<${More} ...${ctx} />`}
    </main>
    <nav class="bnav" aria-label="Main">${[['today', 'Today'], ['board', 'Board'], ['rules', 'Rules'], ['more', 'More']].map(([k, l]) => html`<button class=${view === k || (k === 'more' && view === 'learn') ? 'on' : ''} onClick=${() => setView(k)}>${l}</button>`)}</nav>
    ${modal && html`<${modal.type} ...${ctx} ...${modal.props} close=${() => setModal(null)} />`}
    <${Lightbox} item=${lightbox} onClose=${() => setLightbox(null)} />
    <${Toast} msg=${toast} />`;
}

function Login() {
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const go = async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { await be.signIn(email.trim(), pw); } catch (x) { setErr('Sign-in failed. Check your email and password.'); } setBusy(false); };
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
function cardInfo(ad, ctx) {
  const { data, product } = ctx;
  const tests = data.tests.filter((t) => t.ad_id === ad.id).sort(byCreated);
  const t = tests[tests.length - 1];
  const rules = R.rulesOf(product), econ = R.econOf(product);
  const hist = ad.history || {};
  if (ad.stage === 'testing' && t) {
    const st = R.testStatus(t, data.checkpoints.filter((c) => c.test_id === t.id), rules, econ.aov);
    if (st.due.length) return { line: `Day ${st.day} of ${st.planned}. Day ${st.due[st.due.length - 1]} results due.`, chip: 'Results due', tone: 'mid', glow: 'live' };
    if (st.final) return { line: st.text, chip: 'Finalize', tone: 'live', glow: 'live' };
    if (st.early) return { line: st.text, chip: 'Early stop?', tone: 'fail', glow: 'live' };
    return { line: st.text, chip: `Day ${Math.min(st.day, st.planned)}/${st.planned}`, tone: 'live', glow: 'live' };
  }
  const stats = hist.roas != null ? `${R.xroas(hist.roas)} · ${R.money(hist.cpa)} CPA · ${R.money0(hist.spend)}` : null;
  if (ad.stage === 'winner') {
    const off = ad.tags && ad.tags.active === false, fat = ad.tags && ad.tags.fatiguing;
    return { line: (off ? 'Off · ' + (ad.tags.offReason || 'fatigued') : fat ? 'Running · fatiguing' : 'Running') + (stats ? ' · ' + stats : ''), chip: off ? 'Off' : fat ? 'Fatiguing' : 'Running', tone: off ? 'muted' : fat ? 'mid' : 'pass', glow: off ? null : 'pass' };
  }
  if (ad.stage === 'main') return { line: stats || 'In your Main campaign', chip: ad.tags && ad.tags.fatiguing ? 'Fatiguing' : 'Main', tone: ad.tags && ad.tags.fatiguing ? 'mid' : 'live' };
  if (ad.stage === 'results') return { line: stats || (t && t.result_reason) || '', chip: (R.RESULTS[ad.result] || {}).label || 'Result', tone: toneOf(ad.result) };
  if (ad.stage === 'ready') return { line: 'Waiting for a test slot', chip: 'Ready', tone: 'live' };
  if (ad.stage === 'review') return { line: ad.angle || 'Check it before launch', chip: 'Review', tone: 'muted' };
  return { line: ad.angle || (ad.notes || '').split('\n')[0] || 'Idea', chip: ad.parent_id ? 'Recycled' : 'Idea', tone: 'muted' };
}

function Card(props) {
  const { ad, setModal } = props; const ci = cardInfo(ad, props);
  return html`<button type="button" class=${'card' + (ci.glow ? ' glow-' + ci.glow : '')} onClick=${() => setModal({ type: AdDetail, props: { adId: ad.id } })}>
    <${Media} path=${ad.media_path} type=${ad.media_type} />
    <span class="t"><span class="nm">${displayName(ad)}</span><span class="ln">${ci.line}</span><span class=${'chip t-' + ci.tone}>${ci.chip}</span></span>
  </button>`;
}

const RESULT_GROUPS = [['Pass', ['strong_pass', 'pass']], ['Mid-Tier', ['mid']], ['Insufficient', ['insufficient']], ['Not a fair test', ['unfair']], ['Fail', ['fail']], ['Other', [null, undefined, 'winner']]];
function StageList({ stageKey, list, ctx }) {
  const [open, setOpen] = useState({});
  if (!list.length) return html`<div class="empty">Nothing here</div>`;
  if (stageKey !== 'results') return list.map((ad) => html`<${Card} key=${ad.id} ad=${ad} ...${ctx} />`);
  return RESULT_GROUPS.map(([label, keys]) => {
    const g = list.filter((a) => keys.includes(a.result)); if (!g.length) return null;
    const shown = open[label] ? g : g.slice(0, 4);
    return html`<div class="grp"><span>${label}</span><span>${g.length}</span></div>
      ${shown.map((ad) => html`<${Card} key=${ad.id} ad=${ad} ...${ctx} />`)}
      ${g.length > 4 && html`<button class="link small" style="align-self:flex-start" onClick=${() => setOpen({ ...open, [label]: !open[label] })}>${open[label] ? 'Show less' : `Show all ${g.length}`}</button>`}`;
  });
}

function Board(ctx) {
  const { data, product, stage, setStage, setModal } = ctx;
  const ads = data.ads.filter((a) => a.product_id === product.id && a.stage !== 'retired');
  const by = (k) => ads.filter((a) => a.stage === k).sort((a, b) => (b.launched_on || b.created_at || '').localeCompare(a.launched_on || a.created_at || ''));
  const rules = R.rulesOf(product), econ = R.econOf(product), bev = R.breakEven(econ);
  const live = data.tests.filter((t) => t.status === 'active' && t.product_id === product.id);
  const cur = R.STAGES.find((s) => s.key === stage) || R.STAGES[3];
  return html`
    <section class="tiles" aria-label="Summary">
      <div class="tile"><div class="k">Break-even</div><div class="v">${R.xroas(bev.roas)}</div><div class="s">${R.money(bev.cpa)} CPA at ${R.money(econ.aov)} avg order</div></div>
      <div class="tile"><div class="k">Pass line</div><div class="v">${rules.passARoas}x · $${rules.passACpa}</div><div class="s">${rules.minPurchases}+ purchases, no back-half collapse</div></div>
      <div class="tile"><div class="k">Testing now</div><div class="v">${live.filter((t) => t.stage === 1).length}</div><div class="s">${live.filter((t) => t.stage === 2).length} in Stage 2</div></div>
      <div class="tile"><div class="k">Winners</div><div class="v">${by('winner').length}</div><div class="s">${by('winner').filter((a) => !(a.tags && a.tags.active === false)).length} running now</div></div>
    </section>
    <div class="row board-new"><span class="spacer"></span><button class="btn primary" onClick=${() => setModal({ type: AdForm, props: { mode: 'new' } })}>+ New ad</button></div>
    <div class="board-scroll"><div class="board">
      ${R.STAGES.map((s) => { const list = by(s.key);
        return html`<section class=${'col ' + s.key} aria-label=${s.label}><h2>${s.label}<span>${list.length}</span></h2><div class="hint">${s.hint}</div>
          <${StageList} stageKey=${s.key} list=${list} ctx=${ctx} /></section>`; })}
    </div></div>
    <div class="stagepick" role="tablist" aria-label="Stages">
      ${R.STAGES.map((s) => html`<button role="tab" aria-selected=${s.key === stage} class=${s.key === stage ? 'on' : ''} onClick=${() => setStage(s.key)}><b>${s.label}</b><span>${by(s.key).length}</span></button>`)}
      <button onClick=${() => setModal({ type: AdForm, props: { mode: 'new' } })}><b>+ New</b><span>ad</span></button>
    </div>
    <div class="phonelist">
      <div class="row"><h2 style="font-size:20px">${cur.label}</h2><span class="spacer"></span><span class="muted small">${cur.hint}</span></div>
      <${StageList} stageKey=${cur.key} list=${by(cur.key)} ctx=${ctx} />
    </div>`;
}

// ---------- ad detail ----------
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
  const family = data.ads.filter((a) => a.id !== ad.id && (a.parent_id === ad.id || a.id === ad.parent_id || (ad.parent_id && a.parent_id === ad.parent_id)));
  const decisions = data.decisions.filter((d) => d.ad_id === ad.id).sort((a, b) => String(b.day).localeCompare(String(a.day)));
  const open = (type, props) => setModal({ type, props: { adId: ad.id, ...props } });
  const move = async (to, note) => {
    await be.update('ads', ad.id, { stage: to });
    await be.insert('decisions', { product_id: ad.product_id, ad_id: ad.id, kind: 'move', choice: `Moved to ${(R.STAGES.find((s) => s.key === to) || { label: to }).label}`, reason: note || '' });
    await reload(); say('Moved');
  };
  const del = async () => { await be.remove('ads', ad.id); await reload(); close(); say('Deleted'); };
  const toggleOff = async () => { const tags = { ...(ad.tags || {}), active: ad.tags && ad.tags.active === false ? true : false }; await be.update('ads', ad.id, { tags }); await reload(); };

  const actions = [];
  if (ad.stage === 'idea') actions.push(html`<button class="btn primary" onClick=${() => move('review')}>Send to review</button>`);
  if (ad.stage === 'review') actions.push(html`<button class="btn primary" onClick=${() => move('ready')}>Approve: ready to test</button>`, html`<button class="btn" onClick=${() => move('idea')}>Back to ideas</button>`);
  if (ad.stage === 'ready') actions.push(html`<button class="btn primary" onClick=${() => open(LaunchForm)}>It went live in Meta</button>`);
  if (ad.stage === 'testing' && active) actions.push(html`<button class="btn primary" onClick=${() => open(CheckinForm, { testId: active.id })}>Add results</button>`, html`<button class="btn" onClick=${() => open(FinalizeForm, { testId: active.id })}>Finalize</button>`, html`<button class="btn danger" onClick=${() => open(StopForm, { testId: active.id })}>Stop early</button>`);
  if (ad.stage === 'results' && (ad.result === 'pass' || ad.result === 'strong_pass')) actions.push(html`<button class="btn primary" onClick=${() => open(MainForm, { mode: 'start' })}>Move to Main (Stage 2)</button>`);
  if (ad.stage === 'results' && !(ad.result === 'pass' || ad.result === 'strong_pass')) actions.push(html`<button class="btn" onClick=${() => setModal({ type: AdForm, props: { mode: 'version', adId: ad.id, recycle: true } })}>Recycle with a fix</button>`);
  if (ad.stage === 'main') actions.push(active && active.stage === 2 ? html`<button class="btn primary" onClick=${() => open(MainForm, { mode: 'record', testId: active.id })}>Record Main result</button>` : html`<button class="btn" onClick=${() => open(MainForm, { mode: 'start' })}>Start a Stage 2 check</button>`);
  if (ad.stage === 'winner') actions.push(html`<button class="btn" onClick=${toggleOff}>${ad.tags && ad.tags.active === false ? 'Mark as running' : 'Mark as off (fatigued)'}</button>`);

  return html`<${Modal} wide title=${displayName(ad)} sub=${product.name + ' · ' + (ad.format || 'image')} onClose=${close}>
    <div class="detail">
      <div class="stack">
        <${Media} big path=${ad.media_path} type=${ad.media_type} onOpen=${(url, video) => setLightbox({ url, video })} />
        <div class="row"><button class="btn sm" onClick=${() => setModal({ type: AdForm, props: { mode: 'edit', adId: ad.id } })}>Edit</button>
          <button class="btn sm" onClick=${() => setModal({ type: AdForm, props: { mode: 'version', adId: ad.id } })}>New version</button>
          <span class="spacer"></span>
          ${confirmDel ? html`<span class="small">Delete for good?</span><button class="btn sm danger" onClick=${del}>Delete</button><button class="btn sm ghost" onClick=${() => setConfirmDel(false)}>Keep</button>` : html`<button class="btn sm ghost danger" onClick=${() => setConfirmDel(true)}>Delete</button>`}</div>
        ${family.length > 0 && html`<div class="panel"><h2>Versions</h2>${family.map((f) => html`<button class="card" onClick=${() => setModal({ type: AdDetail, props: { adId: f.id } })}><${Media} path=${f.media_path} type=${f.media_type} /><span class="t"><span class="nm">${displayName(f)}</span><span class="ln">${(R.STAGES.find((s) => s.key === f.stage) || {}).label || f.stage}</span></span></button>`)}</div>`}
      </div>
      <div class="stack">
        <div class="row">
          <span class="chip t-live">${(R.STAGES.find((s) => s.key === ad.stage) || { label: ad.stage }).label}</span>
          ${ad.stage === 'winner' && html`<span class=${'chip t-' + (ad.tags && ad.tags.active === false ? 'muted' : ad.tags && ad.tags.fatiguing ? 'mid' : 'pass')}>${ad.tags && ad.tags.active === false ? 'Off · ' + (ad.tags.offReason || 'fatigued') : ad.tags && ad.tags.fatiguing ? 'Running · fatiguing' : 'Running'}</span>`}
          ${ad.result && ad.result !== 'winner' && html`<span class=${'chip t-' + toneOf(ad.result)}>${(R.RESULTS[ad.result] || {}).label || ad.result}</span>`}
          ${ad.setup_era === 'old' && html`<span class="chip t-mid">Old setup · low confidence</span>`}
          ${ad.launched_on && html`<span class="chip t-muted">Live ${ad.launched_on}</span>`}
        </div>
        ${actions.length > 0 && html`<div class="row">${actions}</div>`}
        <div class="row"><label class="f" style="flex-direction:row;align-items:center;gap:8px">Move to
          <select class="inp" style="width:auto;min-height:36px" value=${ad.stage} onChange=${(e) => move(e.target.value, 'Moved by hand')}>
            ${R.STAGES.map((s) => html`<option value=${s.key}>${s.label}</option>`)}<option value="retired">Retired (hidden)</option></select></label></div>
        ${(ad.headline || ad.primary_text || ad.angle || ad.offer || ad.notes) && html`<div class="panel">
          ${ad.angle && html`<div class="small"><span class="muted">Angle:</span> ${ad.angle}</div>`}
          ${ad.offer && html`<div class="small"><span class="muted">Offer:</span> ${ad.offer}</div>`}
          ${ad.headline && html`<div class="small"><span class="muted">Headline:</span> ${ad.headline}</div>`}
          ${ad.primary_text && html`<div class="small" style="white-space:pre-wrap"><span class="muted">Primary text:</span> ${ad.primary_text}</div>`}
          ${ad.notes && html`<div class="small" style="white-space:pre-wrap"><span class="muted">Notes:</span> ${ad.notes}</div>`}</div>`}
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
    ${(c.landingPage || c.enhancements != null) && html`<div class="tiny muted">Conditions: ${[c.landingPage, c.enhancements ? 'creative enhancements ON' : 'enhancements off', c.shopAds ? 'Shop ads ON' : null].filter(Boolean).join(' · ')}</div>`}
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
  const save = async () => {
    if (!f.base_name.trim()) { say('Give the ad a name.'); return; }
    setBusy(true);
    try {
      const pidUse = src ? src.product_id : product.id;
      let media_path = mode === 'new' ? null : src.media_path, media_type = mode === 'new' ? null : src.media_type;
      if (file) { media_path = await be.upload(`${pidUse}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${extOf(file)}`, file); media_type = file.type; }
      const row = { base_name: f.base_name.trim(), format: f.format, angle: f.angle, offer: f.offer, headline: f.headline, primary_text: f.primary_text, notes: f.notes, concept: f.concept || null, media_path, media_type };
      if (mode === 'edit') { await be.update('ads', src.id, row); await reload(); close(); say('Saved'); return; }
      const ins = await be.insert('ads', { ...row, product_id: pidUse, stage: 'idea', version: mode === 'version' ? (src.version || 1) + 1 : 1, parent_id: mode === 'version' ? src.id : null, tags: {}, history: {} });
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
      <${Field} label="Concept (the idea behind it)"><input value=${f.concept || ''} onInput=${set('concept')} placeholder="Value: $6 per shirt" /><//>
      <${Field} label="Angle"><input value=${f.angle || ''} onInput=${set('angle')} placeholder="Value, person wearing, rotation, gym…" /><//>
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
  const [f, setF] = useState({ date: R.today(), budget: rules.stage1Budget, days: rules.plannedDays, landingPage: 'Current page (Mar 2026+)', enhancements: false, shopAds: false });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const warns = [];
  if (live.length >= rules.slots) warns.push(`${live.length} Stage 1 tests are already live (your limit is ${rules.slots}).`);
  if (spendLive + (+f.budget || 0) > rules.testingCap) warns.push(`Testing spend would be $${spendLive + (+f.budget || 0)}/day, over your $${rules.testingCap} cap.`);
  if (rules.weekendLock && R.isWeekendLock()) warns.push('Weekend lock is on (Friday night to Sunday).');
  if (f.enhancements) warns.push('Creative enhancements ON: Meta will change your ad, so the result says less about your creative.');
  const go = async () => {
    await be.insert('tests', { ad_id: ad.id, product_id: ad.product_id, stage: 1, start_date: f.date, planned_days: +f.days || rules.plannedDays, budget: +f.budget || null, status: 'active', conditions: { landingPage: f.landingPage, enhancements: f.enhancements, shopAds: f.shopAds } });
    await be.update('ads', ad.id, { stage: 'testing', launched_on: f.date, setup_era: 'new' });
    await be.insert('decisions', { product_id: ad.product_id, ad_id: ad.id, kind: 'launch', choice: `Launched at $${f.budget}/day`, day: f.date });
    await reload(); close(); say('Test started. Name now shows the launch date.');
  };
  return html`<${Modal} title="It went live in Meta" sub=${ad.base_name} onClose=${close}>
    ${warns.length > 0 && html`<div class="banner"><ul style="margin:0;padding-left:18px">${warns.map((w) => html`<li>${w}</li>`)}</ul></div>`}
    <div class="form">
      <${Field} label="First day it spent money"><input type="date" value=${f.date} onInput=${set('date')} /><//>
      <${Field} label="Budget ($/day)"><input inputmode="decimal" value=${f.budget} onInput=${set('budget')} /><//>
      <${Field} label="Test window (days)"><input inputmode="numeric" value=${f.days} onInput=${set('days')} /><//>
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
    await be.update('ads', test.ad_id, { stage: 'results', result: pick });
    await be.insert('decisions', { product_id: test.product_id, ad_id: test.ad_id, test_id: test.id, kind: 'result', choice: `Filed as ${R.RESULTS[pick].label}`, reason: why });
    await reload(); close(); say('Filed in Results');
  };
  return html`<${Modal} title="Finalize the test" onClose=${close}>
    ${early && html`<div class="banner">The planned window isn't finished (last check-in was day ${last.day}). Finalizing now is your call.</div>`}
    ${!m && html`<div class="banner">No numbers yet. Add results first.</div>`}
    ${m && html`<div class="status ${toneOf(c.result) === 'pass' ? 'good' : toneOf(c.result) === 'fail' ? 'bad' : 'warn'}"><b>Your rules say: ${R.RESULTS[c.result].label}</b><ul style="margin:6px 0 0;padding-left:18px">${c.evidence.map((x) => html`<li>${x}</li>`)}</ul></div>`}
    ${events.length > 0 && html`<div class="banner">Changes logged during this test: ${events.map((e) => `${e.day} ${e.kind}`).join('; ')}. If they distorted it, file it as "Not a fair test".</div>`}
    <div class="form">
      <${Field} label="File it as"><select value=${pick} onChange=${(e) => setPick(e.target.value)}>${Object.entries(R.RESULTS).filter(([k]) => k !== 'winner').map(([k, v]) => html`<option value=${k}>${v.label}${k === c.result ? ' (your rules)' : ''}</option>`)}</select><//>
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
    await be.update('ads', test.ad_id, { stage: 'results', result });
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
  const { data, adId, mode, testId, close, reload, say } = ctx;
  const ad = data.ads.find((a) => a.id === adId); const product = data.products.find((p) => p.id === ad.product_id); const rules = R.rulesOf(product);
  const test = testId ? data.tests.find((t) => t.id === testId) : null;
  const [f, setF] = useState({ date: R.today(), base: '', after: '', verdict: 'validated', note: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const start = async () => {
    await be.insert('tests', { ad_id: ad.id, product_id: ad.product_id, stage: 2, start_date: f.date, planned_days: rules.stage2Max, status: 'active', conditions: { baseRoas: R.num(f.base) } });
    await be.update('ads', ad.id, { stage: 'main' });
    await be.insert('decisions', { product_id: ad.product_id, ad_id: ad.id, kind: 'move', choice: 'Added to Main (Stage 2)', reason: 'Budget unchanged' });
    await reload(); close(); say('Moved to Main');
  };
  const record = async () => {
    const ok = f.verdict === 'validated';
    await be.update('tests', test.id, { status: 'complete', result: ok ? 'winner' : 'mid', result_reason: `Main ROAS ${f.base || (test.conditions || {}).baseRoas || '?'}x before, ${f.after || '?'}x after.`, override_reason: f.note || null });
    await be.update('ads', ad.id, ok ? { stage: 'winner', result: 'winner', tags: { ...(ad.tags || {}), active: true } } : { stage: 'results', tags: { ...(ad.tags || {}), notValidated: true } });
    await be.insert('decisions', { product_id: ad.product_id, ad_id: ad.id, test_id: test.id, kind: 'result', choice: ok ? 'Validated in Main' : 'Not validated in Main', reason: f.note });
    await reload(); close(); say(ok ? 'Validated winner' : 'Marked not validated');
  };
  const days = test && test.start_date ? R.daysBetween(test.start_date, R.today()) : 0;
  return html`<${Modal} title=${mode === 'start' ? 'Move to Main (Stage 2)' : 'Record the Main result'} sub=${ad.base_name} onClose=${close}>
    ${mode === 'start' ? html`<p class="small muted" style="margin:0">Add one new candidate at a time and keep the Main budget the same. Judge the whole campaign after ${rules.stage2Min} to ${rules.stage2Max} days.</p>
      <div class="form"><${Field} label="Date added to Main"><input type="date" value=${f.date} onInput=${set('date')} /><//><${Field} label="Main ROAS before (baseline)"><input inputmode="decimal" value=${f.base} onInput=${set('base')} /><//></div>
      <div class="row"><button class="btn primary" onClick=${start}>Start Stage 2</button><button class="btn ghost" onClick=${close}>Cancel</button></div>`
    : html`${days < rules.stage2Min && html`<div class="banner">Only ${days} days in Main. Your rule is ${rules.stage2Min} to ${rules.stage2Max}.</div>`}
      <div class="form"><${Field} label="Main ROAS before"><input inputmode="decimal" value=${f.base || ((test && test.conditions) || {}).baseRoas || ''} onInput=${set('base')} /><//>
      <${Field} label="Main ROAS since adding it"><input inputmode="decimal" value=${f.after} onInput=${set('after')} /><//>
      <${Field} label="Verdict"><select value=${f.verdict} onChange=${set('verdict')}><option value="validated">Validated winner</option><option value="not">Not validated</option></select><//>
      <${Field} full label="Note"><input value=${f.note} onInput=${set('note')} /><//></div>
      <div class="row"><button class="btn primary" onClick=${record}>Save</button><button class="btn ghost" onClick=${close}>Cancel</button></div>`}
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
    if (t.stage === 2) { const d = R.daysBetween(t.start_date, R.today()); if (d >= rules.stage2Min) items.push({ tone: 'blue', title: `Judge Stage 2: ${ad.base_name}`, sub: `${d} days in Main · ${p.name}`, tag: 'TODAY', go: () => setModal({ type: MainForm, props: { adId: ad.id, mode: 'record', testId: t.id } }) }); continue; }
    const st = R.testStatus(t, data.checkpoints.filter((c) => c.test_id === t.id), rules, R.econOf(p).aov);
    if (st.early) items.push({ tone: 'red', title: `Early-stop rule met: ${ad.base_name}`, sub: st.text, tag: 'DECIDE', go: () => setModal({ type: AdDetail, props: { adId: ad.id } }) });
    if (st.final) items.push({ tone: 'blue', title: `Finalize: ${displayName(ad)}`, sub: `${p.name} · window complete`, tag: 'TODAY', go: () => setModal({ type: FinalizeForm, props: { testId: t.id } }) });
    else if (st.due.length) items.push({ tone: 'amber', title: `Day ${st.due[st.due.length - 1]} results: ${displayName(ad)}`, sub: `${p.name} · day ${st.day} of ${st.planned}`, tag: 'DUE', go: () => setModal({ type: CheckinForm, props: { testId: t.id } }) });
  }
  const ready = data.ads.filter((a) => a.stage === 'ready');
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
      ${running.length ? html`<div class="list">${running.map((t) => { const ad = data.ads.find((a) => a.id === t.ad_id); return ad && html`<button class="li" style="background:none;border-left:0;border-right:0;border-bottom:0;color:inherit;text-align:left;cursor:pointer;width:100%" onClick=${() => setModal({ type: AdDetail, props: { adId: ad.id } })}><span class="bar blue"></span><span class="grow small"><b>${displayName(ad)}</b><br/><span class="muted">${t.stage === 2 ? 'Stage 2 · Main' : 'Stage 1'} · day ${R.testDay(t)}</span></span></button>`; })}</div>` : html`<div class="empty">No live tests</div>`}
    </section>`;
}

// ---------- rules ----------
const RULE_ROWS = [
  ['Budgets', [['stage1Budget', 'Stage 1 budget per ad set', '$/day'], ['boostedBudget', 'Boosted budget', '$/day'], ['boostAt', 'Boost when 30-day blended ROAS is at least', 'x']]],
  ['Test window', [['plannedDays', 'Test window', 'days'], ['checkins', 'Check-in days', 'day']]],
  ['Pass, Mid, Fail', [['minPurchases', 'Minimum purchases', 'buys'], ['passARoas', 'Pass A: ROAS at least', 'x'], ['passACpa', 'Pass A: CPA at most', '$'], ['passBRoas', 'Pass B: ROAS at least', 'x'], ['passBCpa', 'Pass B: CPA at most', '$'], ['failRoas', 'Fail below ROAS', 'x'], ['strongPct', 'Strong pass: CPA at most', '% of line'], ['collapseDays', 'Back-half collapse window', 'days']]],
  ['Early stop', [['earlyDay', 'From day', 'day'], ['earlySpend', 'Spend at least', '$'], ['earlyMaxPurchases', 'Purchases at most', 'buys']]],
  ['Capacity & timing', [['slots', 'Test slots at once', 'slots'], ['testingCap', 'Testing cap, all products', '$/day'], ['stage2Min', 'Stage 2 minimum', 'days'], ['stage2Max', 'Stage 2 maximum', 'days'], ['raiseStep', 'Budget raise step', '%']]],
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
    try { const n = await importHistory(file, be, data, (p) => setProg(p)); await reload(); setProg({ done: n, total: n, msg: `Imported ${n} ads.` }); say('History imported'); }
    catch (e) { setProg({ msg: 'Import failed: ' + e.message, error: true }); }
  };
  return html`
    <h1 style="font-size:30px">More</h1>
    <div class="grid2">
      <section class="panel"><h2>Learnings</h2><p class="small muted" style="margin:0">Learnings, changes and every decision, per product.</p><div class="row"><button class="btn" onClick=${() => setView('learn')}>Open Learnings</button></div></section>
      <section class="panel"><h2>Import your ad history</h2>
        <p class="small muted" style="margin:0">Load the history file from Claude once: your past ads, images, verdicts and notes.</p>
        ${already && html`<div class="status good">History is already imported. Importing again skips ads that are already here.</div>`}
        <input type="file" accept=".zip" class="inp" onChange=${(e) => runImport(e.target.files[0])} />
        ${prog && html`<div class=${'status ' + (prog.error ? 'bad' : 'live')}>${prog.msg}${prog.total ? ` (${prog.done}/${prog.total})` : ''}</div>`}
      </section>
      <section class="panel"><h2>Backup</h2><p class="small muted" style="margin:0">Download everything as one file. Images stay in your storage.</p><div class="row"><button class="btn" onClick=${exportAll}>Export everything</button></div></section>
      <section class="panel"><h2>Install on your phone</h2><p class="small muted" style="margin:0">iPhone: open this page in Safari, tap Share, then Add to Home Screen. Android: Chrome menu, then Add to Home screen.</p></section>
      <section class="panel"><h2>Account</h2><div class="row"><button class="btn" onClick=${() => be.signOut()}>Sign out</button></div></section>
    </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
