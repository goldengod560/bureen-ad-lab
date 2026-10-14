// Testing rules, break-even math and result classification.
// Every number here is only a default: each product keeps its own editable copy.

export const DEFAULT_RULES = {
  stage1Budget: 17, boostedBudget: 20, boostAt: 3.0,
  plannedDays: 7, checkins: '3, 7',
  minPurchases: 5,
  passARoas: 2.5, passACpa: 20,
  passBRoas: 2.0, passBCpa: 16,
  failRoas: 2.0,
  strongPct: 80,
  collapseDays: 3,
  earlyDay: 4, earlySpend: 60, earlyMaxPurchases: 1,
  slots: 2, testingCap: 60,
  stage2Min: 5, stage2Max: 7,
  raiseStep: 20,
  weekendLock: true,
  benchTarget: 2,
  fatigueCpaUp: 25, fatigueRoasDown: 20, fatigueMinSpend: 50,
};

export const DEFAULT_ECON = {
  mode: 'own',            // own = you set break-even ROAS; costs = calculated from costs below
  beRoas: 2.7,
  aov: 46.81,
  costs: [
    { label: 'Product cost', value: 15 },
    { label: 'Inbound shipping', value: 7.25 },
    { label: 'Packaging', value: 1 },
    { label: 'Payment processing', value: 3, pct: true },
  ],
};

export const STAGES = [
  { key: 'untested', label: 'Untested', hint: 'Ready, retests and ideas' },
  { key: 'testing', label: 'Testing', hint: 'Live in Meta' },
  { key: 'bench', label: 'Bench', hint: 'Passed. Backups for Main' },
  { key: 'main', label: 'In Main', hint: 'Running in Main now' },
  { key: 'exhausted', label: 'Exhausted', hint: 'Fatigued and off' },
  { key: 'mid', label: 'Mid-Tier', hint: 'Close but not a pass' },
  { key: 'failed', label: 'Failed', hint: 'Did not work' },
];
// Off the board, reachable from the shelf row under the board.
export const SHELVES = [
  { key: 'seasonal', label: 'Seasonal', hint: 'Sale and holiday ads' },
  { key: 'retired', label: 'Archived', hint: 'Hidden from everything' },
];
export const stageLabel = (k) => ([...STAGES, ...SHELVES].find((s) => s.key === k) || { label: k }).label;
// Where a filed Stage 1 result goes.
export const stageForResult = (r) => r === 'pass' || r === 'strong_pass' ? 'bench' : r === 'fail' ? 'failed' : r === 'insufficient' || r === 'unfair' ? 'untested' : 'mid';
// Results that mean "not judged yet": they go back to Untested as a retest.
export const isRetestResult = (r) => r === 'insufficient' || r === 'unfair';

export const RESULTS = {
  strong_pass: { label: 'Pass · Strong', tone: 'pass' },
  pass: { label: 'Pass', tone: 'pass' },
  mid: { label: 'Mid-Tier', tone: 'mid' },
  insufficient: { label: 'Insufficient', tone: 'ins' },
  fail: { label: 'Fail', tone: 'fail' },
  unfair: { label: 'Not a fair test', tone: 'ins' },
  held: { label: 'Held in Main', tone: 'pass', main: true },
  not_held: { label: "Didn't hold in Main", tone: 'mid', main: true },
  winner: { label: 'Winner', tone: 'pass', main: true },
};

// Setup eras. Results from Era 1 say little about the creative.
export const ERAS = {
  era1: { label: 'Era 1 · no test system', short: 'Era 1', note: 'One mixed campaign, no testing. Shows what Meta chose to spend on, not a fair test.' },
  era2: { label: 'Era 2 · CBO batches', short: 'Era 2', note: 'Two $24 CBOs (images, videos), three ads at a time.' },
  era3: { label: 'Era 3 · current setup', short: 'Era 3', note: 'One ad per Stage 1 test.' },
};
export const eraOf = (day) => !day ? 'era3' : day < '2026-01-01' ? 'era1' : day < '2026-09-01' ? 'era2' : 'era3';
export const TEST_METHODS = ['Single ad (ABO)', 'Batch (CBO)', 'Straight to Main (no test)', 'Other'];

// Old data used other stage names. Map them on read.
export function normalizeAd(ad) {
  const t = ad.tags || {};
  const out = { ...ad };
  const map = { idea: 'untested', review: 'untested', ready: 'untested', results: stageForResult(ad.result) };
  if (ad.stage === 'winner') out.stage = t.active === false ? 'exhausted' : 'main';
  else if (map[ad.stage]) out.stage = map[ad.stage];
  if (ad.stage === 'ready') out.tags = { ...t, ready: true };
  if (out.stage === 'untested' && isRetestResult(ad.result) && !t.retest) out.tags = { ...(out.tags || t), retest: true };
  if (ad.setup_era === 'old' || ad.setup_era === 'new') out.setup_era = eraOf(ad.launched_on);
  return out;
}

export const rulesOf = (p) => Object.assign({}, DEFAULT_RULES, (p && p.rules) || {});
export const econOf = (p) => {
  const e = Object.assign({}, DEFAULT_ECON, (p && p.economics) || {});
  if (!Array.isArray(e.costs)) e.costs = DEFAULT_ECON.costs.map((c) => ({ ...c }));
  return e;
};
export const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[$,%\s]/g, '')); return isFinite(n) ? n : null; };

export function breakEven(econ) {
  const aov = num(econ.aov) || 0;
  const cost = econ.costs.reduce((s, c) => s + (c.pct ? aov * (num(c.value) || 0) / 100 : (num(c.value) || 0)), 0);
  const profit = aov - cost;
  const calc = { cost, profit, cpa: profit, roas: profit > 0 ? aov / profit : null };
  if (econ.mode === 'own') {
    const roas = num(econ.beRoas);
    return { mode: 'own', roas, cpa: roas ? aov / roas : null, calc };
  }
  return { mode: 'costs', roas: calc.roas, cpa: calc.cpa, calc };
}

export function checkinDays(rules) {
  return String(rules.checkins || '3, 7').split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0).sort((a, b) => a - b);
}

export function metrics(cp, aovFallback) {
  if (!cp) return null;
  const spend = num(cp.spend) || 0, purchases = num(cp.purchases) || 0;
  const revenue = num(cp.revenue) != null ? num(cp.revenue) : (aovFallback ? purchases * aovFallback : null);
  const imp = num(cp.impressions), clicks = num(cp.link_clicks), atc = num(cp.adds_to_cart), co = num(cp.checkouts), hook = num(cp.hook_plays);
  return {
    spend, purchases, revenue, revenueEstimated: num(cp.revenue) == null,
    cpa: purchases ? spend / purchases : null,
    roas: spend && revenue != null ? revenue / spend : null,
    aov: purchases && revenue != null ? revenue / purchases : null,
    ctr: imp && clicks != null ? clicks / imp * 100 : null,
    cpm: imp ? spend / imp * 1000 : null,
    hookRate: imp && hook != null ? hook / imp * 100 : null,
    clickToCart: clicks && atc != null ? atc / clicks * 100 : null,
    cartToBuy: atc ? purchases / atc * 100 : null,
    frequency: num(cp.frequency),
  };
}

// Where the funnel leaked. Compares against the account's own medians when we have them.
export function diagnose(m) {
  if (!m) return null;
  const steps = [];
  if (m.ctr != null) steps.push({ key: 'stop', label: 'Scroll-stop (CTR)', value: m.ctr, unit: '%', ok: m.ctr >= 1.5 });
  if (m.clickToCart != null) steps.push({ key: 'cart', label: 'Click to cart', value: m.clickToCart, unit: '%', ok: m.clickToCart >= 15 });
  if (m.cartToBuy != null) steps.push({ key: 'buy', label: 'Cart to purchase', value: m.cartToBuy, unit: '%', ok: m.cartToBuy >= 30 });
  const weak = steps.find((s) => !s.ok);
  const advice = !weak ? null : weak.key === 'stop' ? 'People are not stopping. Fix the first frame or headline.'
    : weak.key === 'cart' ? 'They click but do not add to cart. Check the offer and the product page.'
    : 'They add to cart but do not buy. Check shipping, price shock or checkout trust.';
  return { steps, weak, advice };
}

export function classify(m, rules, cp) {
  const evidence = [];
  if (!m) return { result: null, evidence: ['No numbers yet.'] };
  evidence.push(`${m.purchases} purchases on $${m.spend.toFixed(2)}.`);
  evidence.push(`ROAS ${m.roas != null ? m.roas.toFixed(2) + 'x' : '—'}, CPA ${m.cpa != null ? '$' + m.cpa.toFixed(2) : '—'}.`);
  if (m.roas == null || m.roas < rules.failRoas) { evidence.push(`Under the ${rules.failRoas}x fail line.`); return { result: 'fail', evidence }; }
  if (m.purchases < rules.minPurchases) { evidence.push(`Under ${rules.minPurchases} purchases, so it is unresolved. It can come back later with a fix.`); return { result: 'insufficient', evidence }; }
  const collapse = cp && cp.last3_purchases != null && num(cp.last3_purchases) === 0;
  if (collapse) evidence.push(`0 purchases in the last ${rules.collapseDays} days: back-half collapse.`);
  const passA = m.roas >= rules.passARoas && m.cpa <= rules.passACpa;
  const passB = m.roas >= rules.passBRoas && m.roas < rules.passARoas && m.cpa <= rules.passBCpa;
  if (!collapse && (passA || passB)) {
    const ceiling = passA ? rules.passACpa : rules.passBCpa;
    const strong = m.cpa <= ceiling * rules.strongPct / 100;
    evidence.push(passA ? `Clears Pass A: ${rules.passARoas}x+ with CPA ≤ $${rules.passACpa}.` : `Clears Pass B: ${rules.passBRoas}x+ with CPA ≤ $${rules.passBCpa}.`);
    if (strong) evidence.push(`CPA is ${Math.round(m.cpa / ceiling * 100)}% of the $${ceiling} line: Strong Pass.`);
    return { result: strong ? 'strong_pass' : 'pass', evidence };
  }
  if (!collapse) evidence.push(m.roas >= rules.passARoas ? `CPA is over $${rules.passACpa}.` : `At ${m.roas.toFixed(2)}x, CPA must be ≤ $${rules.passBCpa}.`);
  return { result: 'mid', evidence };
}

export const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
export const parseDay = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
export const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 864e5);
export const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
export const shortDate = (s) => s ? `${String(s).slice(5, 7)}-${String(s).slice(8, 10)}` : '';

export function testDay(test) { return test && test.start_date ? Math.max(0, daysBetween(test.start_date, today()) + 1) : 0; }

// Status of a running Stage 1 test. Early numbers are status updates, never a verdict.
export function testStatus(test, cps, rules, aov) {
  const planned = test.planned_days || rules.plannedDays;
  const sorted = [...cps].sort((a, b) => a.day - b.day);
  const last = sorted[sorted.length - 1];
  const m = last ? metrics(last, aov) : null;
  const day = testDay(test);
  const due = checkinDays(rules).map((d) => Math.min(d, planned)).filter((d, i, a) => a.indexOf(d) === i)
    .filter((d) => day >= d && !sorted.some((c) => c.day >= d));
  if (!last) return { m, day, planned, due, final: false, text: day ? `Day ${day} of ${planned}. No numbers yet.` : 'Not started.' };
  if (last.day < planned) {
    if (last.day >= rules.earlyDay && m.spend >= rules.earlySpend && m.purchases <= rules.earlyMaxPurchases) {
      return { m, day, planned, due, final: false, early: true, text: `Early-stop rule met on day ${last.day}: $${m.spend.toFixed(0)} spent, ${m.purchases} purchase${m.purchases === 1 ? '' : 's'}. You decide.` };
    }
    const pace = Math.round(m.purchases / Math.max(last.day, 1) * planned * 10) / 10;
    return { m, day, planned, due, final: false, behind: pace < rules.minPurchases, text: `Status, not a verdict. Day ${last.day} of ${planned}, on pace for about ${pace} purchases.` };
  }
  const c = classify(m, rules, last);
  return { m, day, planned, due, final: true, ...c, text: `Window complete. Your rules say: ${RESULTS[c.result].label}.` };
}

export function isWeekendLock(d = new Date()) { const g = d.getDay(), h = d.getHours(); return g === 0 || g === 6 || (g === 5 && h >= 17); }

export const money = (n) => (n == null || !isFinite(n)) ? '—' : '$' + Number(n).toFixed(2);
export const money0 = (n) => (n == null || !isFinite(n)) ? '—' : '$' + Math.round(n).toLocaleString();
export const xroas = (n) => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(2) + 'x';
export const pct = (n) => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(1) + '%';
