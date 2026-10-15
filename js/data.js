// Data layer. Talks to Supabase, or to an in-browser mock when ?mock=1 (for testing without an account).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=19';

const TABLES = ['products', 'ads', 'tests', 'checkpoints', 'events', 'decisions', 'learnings', 'meta_days', 'shop_days'];
const UPSERT_KEYS = { meta_days: 'ad_name,adset,campaign,day', shop_days: 'day' };
const BUCKET = 'ad-media';
// The ads table is called "creatives" in the database: ad blockers block web addresses like /ads?id=.
const T = (t) => (t === 'ads' ? 'creatives' : t);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now());

function supabaseBackend() {
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const urlCache = new Map();
  const check = ({ data, error }) => { if (error) throw new Error(error.message || String(error)); return data; };
  return {
    configured: true,
    async session() { const { data } = await client.auth.getSession(); return data.session; },
    onAuth(fn) { client.auth.onAuthStateChange((_e, s) => fn(s)); },
    async signIn(email, password) { check(await client.auth.signInWithPassword({ email, password })); },
    async signOut() { await client.auth.signOut(); },
    async loadAll() {
      const out = {};
      // Supabase returns at most 1000 rows per request, so page through big tables.
      const OPTIONAL = ['meta_days', 'shop_days'];
      const missing = [];
      await Promise.all(TABLES.map(async (t) => {
        const rows = [];
        for (let from = 0; ; from += 1000) {
          if (OPTIONAL.includes(t)) {
            // Tables added later: if the database setup hasn't been re-run yet, carry on without them.
            const r = await client.from(T(t)).select('*').order('created_at', { ascending: true }).order(t === 'shop_days' ? 'day' : 'id', { ascending: true }).range(from, from + 999);
            if (r.error) { missing.push(t); break; }
            rows.push(...r.data); if (r.data.length < 1000) break; continue;
          }
          const page = check(await client.from(T(t)).select('*').order('created_at', { ascending: true }).order(t === 'shop_days' ? 'day' : 'id', { ascending: true }).range(from, from + 999));
          rows.push(...page); if (page.length < 1000) break;
        }
        out[t] = rows;
      }));
      out.missingTables = missing;
      return out;
    },
    async insert(t, row) { return check(await client.from(T(t)).insert(row).select().single()); },
    async update(t, id, patch) { return check(await client.from(T(t)).update(patch).eq('id', id).select().single()); },
    async remove(t, id) { check(await client.from(T(t)).delete().eq('id', id)); },
    async upsert(t, rows) {
      for (let i = 0; i < rows.length; i += 500) check(await client.from(T(t)).upsert(rows.slice(i, i + 500), { onConflict: UPSERT_KEYS[t] }));
    },
    async syncShopify(days) {
      const { data, error } = await client.functions.invoke('shopify-sync', { body: days ? { days } : {} });
      if (error) {
        let msg = error.message;
        try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (e) { /* keep message */ }
        throw new Error(/not found|404/i.test(msg) ? 'The Shopify sync function is not set up in Supabase yet.' : msg);
      }
      if (data && data.error) throw new Error(data.error);
      return data;
    },
    async upload(path, file) {
      check(await client.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: file.type || undefined }));
      urlCache.delete(path);
      return path;
    },
    async mediaUrl(path) {
      if (!path) return null;
      const hit = urlCache.get(path);
      if (hit && hit.exp > Date.now()) return hit.url;
      const data = check(await client.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 6));
      urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 1000 * 60 * 60 * 5 });
      return data.signedUrl;
    },
  };
}

function mockBackend() {
  const KEY = 'adlab-mock-db';
  let db; try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) { db = null; }
  if (!db) {
    db = Object.fromEntries(TABLES.map((t) => [t, []]));
    ['Crew Neck', 'V-Neck', 'Long Sleeve', 'Thermal', 'Tank Top'].forEach((name, i) => db.products.push({ id: uid(), name, subtitle: '6-Pack', kind: ['crew', 'vneck', 'long', 'thermal', 'tank'][i], sort: i + 1, rules: {}, economics: {}, archived: false, created_at: new Date().toISOString() }));
  }
  TABLES.forEach((t) => { if (!db[t]) db[t] = []; });
  const media = new Map();
  // Keep test-mode images in IndexedDB so they survive a refresh.
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('adlab-mock-media', 1); r.onupgradeneeded = () => r.result.createObjectStore('m'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const idbDo = async (mode, fn) => { const d = await idb(); return new Promise((res, rej) => { const tx = d.transaction('m', mode); const q = fn(tx.objectStore('m')); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); }); };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* quota: fine for mock */ } };
  let signedIn = sessionStorage.getItem('adlab-mock-session') === '1';
  let listener = () => {};
  return {
    configured: true, mock: true,
    async session() { return signedIn ? { user: { email: 'you@example.com' } } : null; },
    onAuth(fn) { listener = fn; },
    async signIn() { signedIn = true; sessionStorage.setItem('adlab-mock-session', '1'); listener({ user: { email: 'you@example.com' } }); },
    async signOut() { signedIn = false; sessionStorage.removeItem('adlab-mock-session'); listener(null); },
    async loadAll() { return JSON.parse(JSON.stringify(db)); },
    async insert(t, row) { const r = { id: uid(), created_at: new Date().toISOString(), ...row }; db[t].push(r); save(); return { ...r }; },
    async update(t, id, patch) { const r = db[t].find((x) => x.id === id); Object.assign(r, patch); save(); return { ...r }; },
    async remove(t, id) { db[t] = db[t].filter((x) => x.id !== id); save(); },
    async upload(path, file) { media.set(path, URL.createObjectURL(file)); try { await idbDo('readwrite', (st) => st.put(file, path)); } catch (e) {} return path; },
    async mediaUrl(path) {
      if (media.has(path)) return media.get(path);
      try { const blob = await idbDo('readonly', (st) => st.get(path)); if (blob) { const u = URL.createObjectURL(blob); media.set(path, u); return u; } } catch (e) {}
      return null;
    },
    async upsert(t, rows) {
      const keys = UPSERT_KEYS[t].split(',');
      for (const r of rows) { const hit = db[t].find((x) => keys.every((k) => String(x[k] ?? '') === String(r[k] ?? ''))); if (hit) Object.assign(hit, r); else db[t].push({ id: uid(), created_at: new Date().toISOString(), ...r }); }
      save();
    },
    async syncShopify() { throw new Error('Shopify sync is not available in test mode.'); },
    async reset() { localStorage.removeItem(KEY); try { await idbDo('readwrite', (st) => st.clear()); } catch (e) {} },
  };
}

export function createBackend() {
  const mock = new URLSearchParams(location.search).has('mock');
  if (mock) return mockBackend();
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return { configured: false };
  return supabaseBackend();
}
