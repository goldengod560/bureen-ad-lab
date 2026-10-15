// Reads an Ads Manager export (CSV or Excel) into one row per ad per day.
// Export at the Ad level, either one day at a time or with Breakdown → Time → Day.
import * as R from './rules.js?v=14';

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

async function readTable(file) {
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
  if (idx.spend < 0) throw new Error('No "Amount spent" column in this file.');
  const out = new Map(); let ranged = 0;
  for (const r of table.slice(1)) {
    const name = String(r[idx.ad_name] ?? '').trim();
    if (!name) continue; // totals row
    let day = idx.day >= 0 ? toDay(r[idx.day]) : null;
    if (!day && idx.start >= 0) { const a = toDay(r[idx.start]), b = idx.end >= 0 ? toDay(r[idx.end]) : a; if (a && a === b) day = a; else if (a) { ranged++; continue; } }
    if (!day) continue;
    const g = (k) => (idx[k] >= 0 ? R.num(r[idx[k]]) : null);
    const row = { ad_name: name, adset: idx.adset >= 0 ? String(r[idx.adset] ?? '').trim() : '', campaign: idx.campaign >= 0 ? String(r[idx.campaign] ?? '').trim() : '', day,
      spend: g('spend') ?? 0, impressions: g('impressions'), reach: g('reach'), frequency: g('frequency'), link_clicks: g('link_clicks'),
      adds_to_cart: g('adds_to_cart'), checkouts: g('checkouts'), purchases: g('purchases') ?? 0, revenue: g('revenue') ?? 0, hook_plays: g('hook_plays') };
    const key = [row.ad_name, row.adset, row.campaign, row.day].join('|');
    out.set(key, row); // a repeated row in the same file replaces the earlier one
  }
  const rows = [...out.values()];
  if (!rows.length) throw new Error(ranged ? 'This file covers several days per row. Export one day at a time, or add Breakdown → Time → Day.' : 'No ad rows found in this file.');
  const days = [...new Set(rows.map((r) => r.day))].sort();
  return { rows, days, ranged, spend: rows.reduce((s, r) => s + (r.spend || 0), 0) };
}

// ---------- matching file rows to ads in the app ----------
export const normName = (s) => String(s || '').toLowerCase().replace(/\s*\|\s*\d{1,2}[-/]\d{1,2}\s*$/, '').replace(/\s+/g, ' ').trim();

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
