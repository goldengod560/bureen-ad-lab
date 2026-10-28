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
  earlyDay: 4, earlySpend: 60, earlyMaxPurchases: 1, underSpend: 85,
  slots: 2, testingCap: 60,
  stage2Min: 5, stage2Max: 7,
  raiseStep: 20,
  weekendLock: true,
  benchTarget: 2,
  fatigueCpaUp: 25, fatigueRoasDown: 20, fatigueMinSpend: 50, fatigueCtrDown: 20,
};

// ---------- economics ----------
// Store = the whole shop, blended. Each product has its own costs; break-even comes from one formula,
// with the order value as the input. Shared costs (postage, packaging, fees) come from the store
// unless the product overrides them. Testing targets live in the rules and are never called break-even.
export const STORE_DEFAULTS = { aov: 47.54, cogsPct: null, ship: 7.6, pack: 0.6, feePct: 2.9, feeFixed: 0.3, other: 0, fixedMonthly: 84, margin: 35, bundle2: 10, bundle3: 15 }; // fixed: Shopify $39 + AOV.ai $12.79 + Trustoo $11.99 + Blockify $19.99
export const SHARED_COSTS = [
  ['ship', 'Postage per order', '$'], ['pack', 'Packaging per order', '$'], ['feePct', 'Card fee', '%'], ['feeFixed', 'Card fee per order', '$'], ['other', 'Other cost per order', '$'],
];
let STORE = { ...STORE_DEFAULTS };
export const setStoreEcon = (s) => { STORE = { ...STORE_DEFAULTS, ...(s || {}) }; };
export const storeEcon = () => STORE;
// Verified Crew numbers, used until Crew's own economics are saved.
const CREW_START = { price: 36, packCost: 15 };

export const STAGES = [
  { key: 'next', label: 'Up Next', hint: 'Ready to launch, in order' },
  { key: 'testing', label: 'Testing', hint: 'Live in Meta' },
  { key: 'bench', label: 'Bench', hint: 'Passed. Backups for Main' },
  { key: 'main', label: 'In Main', hint: 'Running in Main now' },
  { key: 'ideas', label: 'Ideas', hint: 'Drafts and new uploads' },
  { key: 'retest', label: 'Retest', hint: 'Never got a fair shot' },
  { key: 'exhausted', label: 'Exhausted', hint: 'Fatigued and off' },
  { key: 'mid', label: 'Mid-Tier', hint: 'Close but not a pass' },
  { key: 'failed', label: 'Failed', hint: 'Did not work' },
];
// Off the board, reachable from the shelf row under the board.
export const SHELVES = [
  { key: 'seasonal', label: 'Seasonal', hint: 'Sale and holiday ads' },
  { key: 'retired', label: 'Archived', hint: 'Hidden from everything' },
];
// Up Next order. Ads queued before this existed fall back to when they were added.
export const queueOf = (ad) => { const q = ad.tags && ad.tags.queue; return q == null ? (Date.parse(ad.created_at) || 0) : q; };
export const stageLabel = (k) => ([...STAGES, ...SHELVES].find((s) => s.key === k) || { label: k }).label;
// Where a filed Stage 1 result goes.
export const stageForResult = (r) => r === 'pass' || r === 'strong_pass' ? 'bench' : r === 'fail' ? 'failed' : r === 'insufficient' || r === 'unfair' ? 'retest' : 'mid';
// Results that mean "not judged yet": they go to the Retest folder.
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

// The angle list: the main message an ad leads with. Same for every product, so results compare.
export const ANGLES = [
  { name: 'Price per shirt', hint: 'Leads with the price of one shirt.', examples: ['"ONLY $6 EACH."', '"$6 PER SHIRT. Why pay more?"', '"$8 per tee + free shipping" (Long Sleeve)'] },
  { name: 'Pack total', hint: 'Leads with the price of the whole pack.', examples: ['"6 TEES. $36."', '"6 TEES. ONE DRAWER."', '"$36 6-Pack"'] },
  { name: 'Discount / sale', hint: 'Leads with money off or a sale.', examples: ['"Black Friday 18% off"', '"Winter sale: 15% off"', '"Buy 3, save 15%"'] },
  { name: 'Quality', hint: 'Leads with how good the shirt is: material, feel, how it holds up.', examples: ['"Why 100% cotton?"', '"Soft. Breathable."', '"Built to last wash after wash"'] },
  { name: 'Premium Value', hint: 'Leads with the contrast: a low price on a shirt that looks or feels like it costs more.', examples: ['"The $6 tee that doesn\'t look $6"', '"Looks like $20. Costs $6."', '"Cheap price. Not a cheap shirt."'] },
  { name: 'Brand', hint: 'Leads with Sada itself: why pick the brand, or a brand look with no price.', examples: ['"Why Sada?"', '"Available on Bureen"', 'Sada logo poster, shirts on graffiti, no price'] },
  { name: 'Fit', hint: 'Leads with how it fits or the sizes.', examples: ['"Sada got the big sizes on lock"', 'Someone showing how it fits on the body', '"Fits right, even after washing"'] },
  { name: 'Lifestyle', hint: 'Leads with a person living their day in it.', examples: ['"Shift ready. Comfort that shows up."', 'Someone at work, the gym or out', '"Your everyday rotation"'] },
  { name: 'Curiosity', hint: 'Leads with a hook that makes people stop and wonder.', examples: ['"FOR ONLY THAT PRICE???"', '"Rent\'s wild, food crazy… our tees? $6."', 'A question or surprise before the offer'] },
  { name: 'Urgency', hint: 'Leads with "act now": running out or ending soon.', examples: ['"Going fast. Act now."', '"Last day for free shipping"', '"Restock won\'t last"'] },
];
const ANGLE_MAP = { '$6 per shirt': 'Price per shirt', '$8 per shirt + free shipping': 'Price per shirt', 'Pack value ($36 / 6 tees)': 'Pack total', 'Quality / 100% cotton': 'Quality',
  'No price (brand / product only)': 'Brand', 'Why Sada': 'Brand', 'Brand / Why Sada': 'Brand', 'Fit / big sizes (testimonial)': 'Fit', 'Price shock / curiosity': 'Curiosity', 'Urgency (going fast)': 'Urgency' };
export const anglesFor = (product) => [...ANGLES.map((a) => a.name), ...(((product && product.rules) || {}).extraAngles || [])];
export const angleHint = (name) => (ANGLES.find((a) => a.name === name) || {}).hint || '';
export const angleExamples = (name) => (ANGLES.find((a) => a.name === name) || {}).examples || [];

// Concept = what the picture or video shows (the creative style). Fixed list, so styles compare.
export const CONCEPTS = [
  { name: 'Product stack', hint: 'Shirts folded and stacked on a clean background.', examples: ['Fold Stack B&W', 'Olive Stack', 'Dark Stack', 'Why 100% Cotton'] },
  { name: 'Flat-lay', hint: 'Shirts laid out on a surface: graffiti, bed, floor.', examples: ['Bed (Spray)', 'Pic Color', 'Phone'] },
  { name: 'Display walkthrough', hint: 'Video walking up to the shirt display.', examples: ['Rent', '1.5', '2.75'] },
  { name: 'Try-on', hint: 'A person wearing it and showing the fit.', examples: ['Try-On', 'Try On', 'Model'] },
  { name: 'Lifestyle shot', hint: 'A person in a real setting: work, gym, street.', examples: ['Shift Ready'] },
  { name: 'Close-up', hint: 'Fabric, tag or stitching up close.', examples: ['Tag', 'Close Up Shot'] },
  { name: 'Graphic / poster', hint: 'Mostly design and text, few real shirts.', examples: ['Poster 2', 'Image 1 (Available on Bureen)'] },
  { name: 'Packaging / unboxing', hint: 'The box or mailer, opening the order.', examples: ['Packing orders, FedEx drop-off'] },
  { name: 'Talking / UGC', hint: 'Someone talking to the camera, review style.', examples: ['Customer or creator talking about the shirts'] },
];
const CONCEPT_MAP = { 'Product stack, $6 headline': 'Product stack', 'Product stack + fabric close-up': 'Product stack', 'Pack total headline': 'Product stack',
  'Flat-lay (graffiti / bed)': 'Flat-lay', 'Bed spray': 'Flat-lay', 'Try-On': 'Try-on' };
// Concepts for the imported history ads (by their history number).
const HISTORY_CONCEPTS = { h01: 'Product stack', h04: 'Product stack', h08: 'Product stack', h12: 'Product stack', h13: 'Product stack', h21: 'Product stack', h22: 'Product stack', h26: 'Product stack', h35: 'Product stack', h40: 'Product stack', h45: 'Product stack', h47: 'Product stack',
  h11: 'Flat-lay', h14: 'Flat-lay', h18: 'Flat-lay', h25: 'Flat-lay', h32: 'Flat-lay', h43: 'Flat-lay', h46: 'Flat-lay',
  h02: 'Display walkthrough', h05: 'Display walkthrough', h07: 'Display walkthrough', h19: 'Display walkthrough', h20: 'Display walkthrough', h23: 'Display walkthrough', h28: 'Display walkthrough', h31: 'Display walkthrough', h33: 'Display walkthrough', h39: 'Display walkthrough',
  h06: 'Try-on', h36: 'Try-on', h44: 'Try-on', h48: 'Try-on', h29: 'Lifestyle shot', h15: 'Close-up', h42: 'Close-up', h30: 'Graphic / poster', h49: 'Graphic / poster' };
export const conceptsFor = (product) => [...CONCEPTS.map((a) => a.name), ...(((product && product.rules) || {}).extraConcepts || [])];
export const conceptInfo = (name) => CONCEPTS.find((a) => a.name === name) || null;

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
  const map = { idea: 'ideas', review: 'ideas', ready: 'next', results: stageForResult(ad.result) };
  if (ad.stage === 'winner') out.stage = t.active === false ? 'exhausted' : 'main';
  else if (map[ad.stage]) out.stage = map[ad.stage];
  // "Untested" was split into Up Next (ready), Retest and Ideas.
  if (ad.stage === 'untested') out.stage = t.ready ? 'next' : (t.retest || isRetestResult(ad.result)) ? 'retest' : 'ideas';
  if (ad.setup_era === 'old' || ad.setup_era === 'new') out.setup_era = eraOf(ad.launched_on);
  if (ad.angle && ANGLE_MAP[ad.angle.trim()]) out.angle = ANGLE_MAP[ad.angle.trim()];
  // "Doesn't look $6" ads lead with price vs. quality contrast: Premium Value.
  if (/doesn'?t look \$?6/i.test(ad.base_name || '') && (!out.angle || ['Quality', 'Price per shirt'].includes(out.angle))) out.angle = 'Premium Value';
  if (ad.concept && CONCEPT_MAP[ad.concept.trim()]) out.concept = CONCEPT_MAP[ad.concept.trim()];
  const hid = ad.history && ad.history.importId;
  if (hid && HISTORY_CONCEPTS[hid] && (!ad.concept || CONCEPT_MAP[ad.concept.trim()])) out.concept = HISTORY_CONCEPTS[hid];
  return out;
}

export const rulesOf = (p) => Object.assign({}, DEFAULT_RULES, (p && p.rules) || {});
export function econOf(p, store = STORE) {
  const raw = (p && p.economics) || {};
  const e = raw.v === 2 ? raw : p && p.kind === 'crew' ? CREW_START : {};
  const o = { price: num(e.price), packCost: num(e.packCost), ownAov: num(e.aov), own: {}, shipCharge: num(e.shipCharge) || 0 };
  for (const [k] of SHARED_COSTS) { o.own[k] = e[k] === '' || e[k] == null ? null : num(e[k]); o[k] = o.own[k] ?? num(store[k]) ?? 0; }
  o.set = o.price > 0 && o.packCost != null;
  o.aov = o.ownAov || num(store.aov) || o.price || null; // typical order, used when an order size is needed
  // One break-even ROAS per product, used to judge every ad (so it doesn't move with each order).
  // Crew: 2.85x estimate (store average order with your bundle discounts). Others: single-pack break-even until set.
  o.opBEOwn = num(e.opBE);
  const single = o.set ? beOrder(o, 1, 0) : null;
  o.opBE = o.opBEOwn || (p && p.kind === 'crew' ? 2.85 : single && single.roas ? Math.round(single.roas * 100) / 100 : null);
  return o;
}
export const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[$,%\s]/g, '')); return isFinite(n) ? n : null; };

// Break-even at an order worth V. Product cost scales with order value (cost per pack ÷ pack price).
// That is exact for 1 or 2 full-price packs and an estimate for any other order size.
// Break-even for a real order: n packs at your bundle discount. Product cost is per pack (not scaled by price),
// postage is paid once, and on a 1-pack order the shipping the customer pays comes off your postage.
export function beOrder(e, packs = 1, pct = 0) {
  if (!e || !e.set) return null;
  const V = packs * e.price * (1 - (pct || 0) / 100);
  const cogs = packs * e.packCost;
  const fees = V * (e.feePct || 0) / 100 + (e.feeFixed || 0);
  const ship = packs === 1 ? Math.max(0, (e.ship || 0) - (e.shipCharge || 0)) : (e.ship || 0);
  const contrib = V - cogs - fees - ship - (e.pack || 0) - (e.other || 0);
  return { V, cogs, fees, ship, contrib, cpa: contrib > 0 ? contrib : null, roas: contrib > 0 ? V / contrib : null };
}
export function beAt(e, V) {
  V = num(V);
  if (!e || !e.set || !V) return null;
  const cogs = e.packCost / e.price * V;
  const fees = V * (e.feePct || 0) / 100 + (e.feeFixed || 0);
  const contrib = V - cogs - fees - (e.ship || 0) - (e.pack || 0) - (e.other || 0);
  return { V, cogs, fees, contrib, cpa: contrib > 0 ? contrib : null, roas: contrib > 0 ? V / contrib : null };
}

// Store-wide break-even. Until you enter the store's own product cost %, it borrows Crew's ratio and says so.
export function storeBE(crew, s = STORE) {
  const V = num(s.aov);
  let pct = num(s.cogsPct), borrowed = false;
  if (pct == null && crew && crew.set) { pct = crew.packCost / crew.price * 100; borrowed = true; }
  if (!V || pct == null) return { missing: true, V };
  const fees = V * (num(s.feePct) || 0) / 100 + (num(s.feeFixed) || 0);
  const contrib = V - V * pct / 100 - fees - (num(s.ship) || 0) - (num(s.pack) || 0) - (num(s.other) || 0);
  return { V, pct, borrowed, estimated: borrowed, contrib, cpa: contrib > 0 ? contrib : null, roas: contrib > 0 ? V / contrib : null };
}

// How an ad's real numbers compare with break-even at its own average order.
export function vsBreakEven(e, m) {
  if (!m || !m.purchases || m.roas == null) return null;
  if (!e || !e.opBE) return { missing: true };
  const V = m.aov || e.aov;
  const contrib = V / e.opBE; // what one order leaves to pay for the ad, at this break-even
  const be = { roas: e.opBE, cpa: contrib, contrib };
  const diff = (m.roas / e.opBE - 1) * 100;
  const perOrder = contrib - (m.cpa ?? 0);
  const band = diff >= 5 ? 'above' : diff <= -5 ? 'below' : 'near';
  return { be, V, diff, perOrder, band, estimated: true, label: band === 'above' ? 'Above break-even' : band === 'below' ? 'Below break-even' : 'Near break-even' };
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
// live = running totals from the Ads Manager files ({ m, day, through }). When the files are newer
// than the last check-in, the status uses them, so the card always shows the latest numbers.
// "Keep running": you saw the Pause? alert and chose to keep the ad on. The alert is quieted for this test
// (the numbers still show), until you undo it.
export function testStatus(test, cps, rules, aov, live) {
  const st = testStatusRaw(test, cps, rules, aov, live);
  const kr = (test.conditions || {}).keepRunning;
  if (st.early && kr) return { ...st, early: false, kept: true, text: `You chose to keep it running (${shortDate(kr)}). ` + st.text.replace(/^Pause it\? /, '').replace(/ You decide\.$/, '') };
  return st;
}
function testStatusRaw(test, cps, rules, aov, live) {
  const planned = test.planned_days || rules.plannedDays;
  const sorted = [...cps].sort((a, b) => a.day - b.day);
  const last = sorted[sorted.length - 1];
  const day = testDay(test);
  const due = checkinDays(rules).map((d) => Math.min(d, planned)).filter((d, i, a) => a.indexOf(d) === i)
    .filter((d) => day > d && !sorted.some((c) => c.day >= d)); // day d's results are due the day after it ends
  const useLive = live && live.m && live.m.spend > 0 && (!last || (last.day < planned && live.day > last.day));
  const m = useLive ? live.m : last ? metrics(last, aov) : null;
  const atDay = useLive ? Math.max(live.day, 1) : last ? last.day : 0;
  const src = useLive ? ` (your files through ${shortDate(live.through)})` : '';
  if (!m) return { m, day, planned, due, final: false, text: day ? `Day ${day} of ${planned}. No numbers yet.` : test.start_date ? `Partial day today. Day 1 is ${shortDate(test.start_date)}.` : 'Not started.' };
  if (useLive || last.day < planned) {
    const s = (n) => (n === 1 ? '' : 's');
    if (atDay >= rules.earlyDay && m.spend >= rules.earlySpend && m.purchases <= rules.earlyMaxPurchases) {
      return { m, day, planned, due, final: false, early: true, live: useLive, text: `Pause it? Early-stop rule met on day ${atDay}: $${m.spend.toFixed(0)} spent, ${m.purchases} purchase${s(m.purchases)}${src}. You decide.` };
    }
    // Under the fail line after a fair amount of spend: say so, and show what it would take to still pass.
    // Under the fail line: waits for more spend than the 0–1 sale rule, because single days swing a lot.
    if (atDay >= rules.earlyDay && m.spend >= (rules.underSpend ?? rules.earlySpend) && (m.roas ?? 0) < rules.failRoas) {
      const left = Math.max(0, planned - atDay);
      const daily = num(test.budget) || m.spend / Math.max(atDay, 1);
      const endSpend = m.spend + left * daily;
      const avgOrder = m.aov || aov || 36;
      const need = Math.max(rules.minPurchases, Math.ceil(endSpend / rules.passACpa), Math.ceil(endSpend * rules.passARoas / avgOrder));
      const more = Math.max(0, need - m.purchases);
      const reach = left ? ` To still pass it needs about ${more} more buy${s(more)} in ${left} day${s(left)}.` : '';
      return { m, day, planned, due, final: false, early: true, under: true, live: useLive, need: more, left,
        text: `Pause it? ${xroas(m.roas)} after $${m.spend.toFixed(0)}, under your ${rules.failRoas}x fail line${src}.${reach} You decide.` };
    }
    const pace = Math.round(m.purchases / Math.max(atDay, 1) * planned * 10) / 10;
    const onTrack = m.roas != null && m.purchases && m.roas >= rules.passARoas && m.cpa <= rules.passACpa;
    return { m, day, planned, due, final: false, live: useLive, onTrack, behind: pace < rules.minPurchases,
      text: `Status, not a verdict. ${useLive && live.day < 1 ? 'Partial day before day 1' : `Day ${atDay} of ${planned}`}: ${xroas(m.roas)}, ${m.purchases} buy${s(m.purchases)}, on pace for about ${pace}${src}.${onTrack ? ' On track for a pass by your test rule (profit is shown separately below).' : ''}` };
  }
  const c = classify(m, rules, last);
  return { m, day, planned, due, final: true, ...c, text: `Window complete. Your rules say: ${RESULTS[c.result].label}.` };
}

export function isWeekendLock(d = new Date()) { const g = d.getDay(), h = d.getHours(); return g === 0 || g === 6 || (g === 5 && h >= 17); }

export const money = (n) => (n == null || !isFinite(n)) ? '—' : '$' + Number(n).toFixed(2);
export const money0 = (n) => (n == null || !isFinite(n)) ? '—' : '$' + Math.round(n).toLocaleString();
export const xroas = (n) => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(2) + 'x';
export const pct = (n) => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(1) + '%';
