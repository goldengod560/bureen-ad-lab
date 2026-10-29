// Reads an Ads Manager export (CSV or Excel) into one row per ad per day.
// Export at the Ad level, either one day at a time or with Breakdown → Time → Day.
import * as R from './rules.js?v=83';

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

async function loadXlsx() {
  if (window.XLSX) return window.XLSX;
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/xlsx.full.min.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the Excel reader.')); document.head.appendChild(s); });
  return window.XLSX;
}

export async function readTable(file) {
  if (/\.xlsx?$/i.test(file.name)) {
    const X = await loadXlsx();
    const wb = X.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  }
  return parseCSV(await file.text());
}

const COLS = {
  ad_name: [/^ad name$/],
  adset: [/^ad set name$/],
  campaign: [/^campaign name$/],
  day: [/^day$/],
  start: [/^reporting starts?$/],
  end: [/^reporting ends?$/],
  spend: [/^amount spent/],
  impressions: [/^impressions$/],
  reach: [/^reach$/],
  frequency: [/^frequency$/],
  link_clicks: [/^link clicks$/],
  adds_to_cart: [/^(website )?adds to cart$/],
  checkouts: [/^(website )?checkouts initiated$/],
  purchases: [/^(website )?purchases$/, /^purchases \(all\)$/],
  revenue: [/^(website )?purchases conversion value$/, /^purchase conversion value$/],
  hook_plays: [/^3-second video plays$/],
  // Fallbacks for exports that only have Results / ROAS / CPC columns
  results: [/^results$/],
  result_type: [/^result type$/],
  results_value: [/^results value$/],
  attribution: [/^attribution setting$/],
  roas_all: [/^purchase roas/],          // all purchases: website + on Facebook/Instagram (Shop)
  roas_web: [/^website purchase roas/],  // website only
  cpc: [/^cpc \(cost per link click\)/],
};

function toDay(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

export async function readMetaFile(file) {
  const table = await readTable(file);
  if (!table.length) throw new Error('The file is empty.');
  const head = table[0].map((h) => String(h).trim().toLowerCase());
  const idx = {};
  for (const [k, pats] of Object.entries(COLS)) idx[k] = head.findIndex((h) => pats.some((p) => p.test(h)));
  if (idx.ad_name < 0) throw new Error('No "Ad name" column. In Ads Manager, export from the Ads tab (ad level).');
  const out = new Map(); let ranged = 0, empty = 0; const attr = new Set(); const periods = []; const notBuys = new Set();
  for (const r of table.slice(1)) {
    const name = String(r[idx.ad_name] ?? '').trim();
    if (!name) continue; // totals row
    if (idx.attribution >= 0 && String(r[idx.attribution] || '').trim()) attr.add(String(r[idx.attribution]).trim());
    let day = idx.day >= 0 ? toDay(r[idx.day]) : null;
    if (!day && idx.start >= 0) { const a = toDay(r[idx.start]), b = idx.end >= 0 ? toDay(r[idx.end]) : a; if (a && a === b) day = a; else if (a) {
      ranged++;
      // A whole-period row (no daily breakdown): keep only its reach / impressions / frequency.
      const imp = idx.impressions >= 0 ? R.num(r[idx.impressions]) : null, reach = idx.reach >= 0 ? R.num(r[idx.reach]) : null;
      let freq = idx.frequency >= 0 ? R.num(r[idx.frequency]) : null; if (freq == null && imp && reach) freq = imp / reach;
      if (b && imp > 0 && reach > 0) periods.push({ ad_name: name, adset: idx.adset >= 0 ? String(r[idx.adset] ?? '').trim() : '', campaign: idx.campaign >= 0 ? String(r[idx.campaign] ?? '').trim() : '', from: a, to: b, reach, impressions: imp, frequency: Math.round(freq * 100) / 100 });
      continue;
    } }
    if (!day) continue;
    const g = (k) => (idx[k] >= 0 ? R.num(r[idx[k]]) : null);
    const spend = g('spend') ?? 0;
    const isBuy = idx.result_type >= 0 && /purchase/i.test(String(r[idx.result_type] || ''));
    let purchases = g('purchases'); if (purchases == null && isBuy) purchases = g('results') ?? 0;
    // Revenue: the purchase value column if there is one; else Results value (when results are purchases);
    // else all-purchase ROAS × spend; website-only ROAS last, because it misses Shop purchases.
    let revenue = g('revenue');
    if (revenue == null && isBuy && g('results_value') != null) revenue = g('results_value');
    const roasCol = g('roas_all') != null ? g('roas_all') : g('roas_web');
    if (revenue == null && roasCol != null) revenue = Math.round(roasCol * spend * 100) / 100;
    let clicks = g('link_clicks'); if (clicks == null && g('cpc')) clicks = Math.round(spend / g('cpc'));
    if (idx.purchases < 0 && !isBuy && idx.result_type >= 0 && spend > 0) notBuys.add(name);
    const row = { ad_name: name, adset: idx.adset >= 0 ? String(r[idx.adset] ?? '').trim() : '', campaign: idx.campaign >= 0 ? String(r[idx.campaign] ?? '').trim() : '', day,
      spend, impressions: g('impressions'), reach: g('reach'), frequency: g('frequency'), link_clicks: clicks,
      adds_to_cart: g('adds_to_cart'), checkouts: g('checkouts'), purchases: purchases ?? 0, revenue: revenue ?? 0, hook_plays: g('hook_plays') };
    // Ads Manager lists every ad you've ever had, every day, even when it didn't run. Skip those empty rows.
    if (!spend && !(row.impressions > 0) && !row.purchases) { empty++; continue; }
    const key = [row.ad_name, row.adset, row.campaign, row.day].join('|');
    out.set(key, row); // a repeated row in the same file replaces the earlier one
  }
  const rows = [...out.values()];
  if (!rows.length && periods.length) return { kind: 'freq', periods };
  if (idx.spend < 0) throw new Error('No "Amount spent" column in this file.');
  if (idx.purchases < 0 && idx.results < 0) throw new Error('No purchases in this file. Add the "Purchases" (or "Results") column in Ads Manager and export again.');
  if (!rows.length) throw new Error(ranged ? 'This file covers several days per row but has no Reach or Impressions to use for frequency. For daily numbers, add Breakdown → Time → Day.' : empty ? 'No ad spent anything on the days in this file.' : 'No ad rows found in this file.');
  const days = [...new Set(rows.map((r) => r.day))].sort();
  return { rows, days, ranged, empty, attribution: [...attr], notBuys: [...notBuys], spend: rows.reduce((s, r) => s + (r.spend || 0), 0) };
}

// ---------- matching file rows to ads in the app ----------
// Names match even if one side has an apostrophe, a curly quote or a different dash ("Doesn't" = "Doesnt").
export const normName = (s) => String(s || '').toLowerCase().replace(/\s*\|\s*\d{1,2}[-/]\d{1,2}\s*$/, '')
  .replace(/['\u2018\u2019\u201C\u201D"`´]/g, '').replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim();

export function rowsForAd(ad, metaDays) {
  const n = normName(ad.base_name);
  return metaDays.filter((r) => normName(r.ad_name) === n);
}

// Sum a list of daily rows.
export function sumRows(rows) {
  const t = { spend: 0, impressions: 0, link_clicks: 0, adds_to_cart: 0, checkouts: 0, purchases: 0, revenue: 0, hook_plays: 0, reach: 0, freqW: 0 };
  for (const r of rows) {
    for (const k of ['spend', 'impressions', 'link_clicks', 'adds_to_cart', 'checkouts', 'purchases', 'revenue', 'hook_plays']) t[k] += Number(r[k]) || 0;
    t.freqW += (Number(r.frequency) || 0) * (Number(r.impressions) || 0);
  }
  t.frequency = t.impressions ? t.freqW / t.impressions : null;
  t.roas = t.spend ? t.revenue / t.spend : null;
  t.cpa = t.purchases ? t.spend / t.purchases : null;
  t.ctr = t.impressions ? t.link_clicks / t.impressions * 100 : null;
  return t;
}
