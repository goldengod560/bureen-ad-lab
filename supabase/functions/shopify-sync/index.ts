// Bureen Ad Lab: pull daily order totals from Shopify (read-only) into shop_days.
// Runs as a Supabase Edge Function. Shopify credentials live in Supabase secrets, never in the app:
//   SHOPIFY_SHOP           your store's subdomain, e.g. "bureen" for bureen.myshopify.com
//   SHOPIFY_CLIENT_ID      from your Shopify Dev Dashboard app (Settings)
//   SHOPIFY_CLIENT_SECRET  from the same page
// Only a signed-in Ad Lab user can call it. It only reads orders; it never changes anything in Shopify.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const API_VERSION = '2026-07';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function shopToken(shop: string) {
  const r = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: Deno.env.get('SHOPIFY_CLIENT_ID') ?? '', client_secret: Deno.env.get('SHOPIFY_CLIENT_SECRET') ?? '' }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error('Shopify refused the app credentials: ' + (t.error_description || t.error || r.status));
  return t.access_token as string;
}

async function gql(shop: string, token: string, query: string, variables: Record<string, unknown>) {
  const r = await fetch(`https://${shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error('Shopify: ' + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

// Counted the way Shopify's Analytics page counts:
// a sale lands on the day the order was placed (processedAt), cancelled orders included;
// a refund or cancellation lands on the day it happened (not the order's day).
const ORDERS = `query($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      processedAt test cancelledAt
      totalPriceSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      currentSubtotalLineItemsQuantity
      refunds(first: 10) { createdAt totalRefundedSet { shopMoney { amount } } }
    }
  }
}`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const auth = req.headers.get('Authorization') ?? '';
    let pub = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    if (!pub) { try { pub = Object.values(JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}'))[0] as string; } catch { /* none */ } }
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, pub, { global: { headers: { Authorization: auth } } });
    const { data: u, error: ue } = await sb.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
    if (ue || !u?.user) return json({ error: 'Sign in first.' }, 401);

    const shop = (Deno.env.get('SHOPIFY_SHOP') ?? '').replace(/\.myshopify\.com.*$/, '').replace(/^https?:\/\//, '').trim();
    if (!shop) return json({ error: 'SHOPIFY_SHOP secret is not set in Supabase.' }, 400);
    const body = await req.json().catch(() => ({}));
    const token = await shopToken(shop);
    const tz = (await gql(shop, token, '{ shop { ianaTimezone } }', {})).shop.ianaTimezone || 'America/Chicago';

    // Re-pull the last few days every time; the Sync button and the first run go back as far as Shopify allows (about 60 days).
    const { data: last } = await sb.from('shop_days').select('day').order('day', { ascending: false }).limit(1);
    const days = Math.min(Number(body.days) || (last && last.length ? 4 : 58), 58);
    const since = new Date(Date.now() - days * 864e5).toISOString();

    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const firstDay = fmt.format(new Date(since));
    // Ask Shopify from a day and a half earlier so the first day is whole (only days from firstDay on are written).
    const qSince = new Date(new Date(since).getTime() - 1.5 * 864e5).toISOString();
    const blank = (day: string) => ({ day, orders: 0, gross: 0, refunds: 0, discounts: 0, tax: 0, units: 0 });
    const agg = new Map<string, ReturnType<typeof blank>>();
    const at = (iso: string) => { const day = fmt.format(new Date(iso)); if (day < firstDay) return null; if (!agg.has(day)) agg.set(day, blank(day)); return agg.get(day)!; };
    const num = (m: { shopMoney?: { amount?: string } } | null | undefined) => Number(m?.shopMoney?.amount) || 0;
    let after: string | null = null, n = 0;
    do {
      // Orders placed in the window, plus older orders refunded or cancelled in it.
      const d = await gql(shop, token, ORDERS, { q: `updated_at:>='${qSince}' OR processed_at:>='${qSince}'`, after });
      for (const o of d.orders.nodes) {
        if (o.test) continue;
        const total = num(o.totalPriceSet), tax = num(o.totalTaxSet), taxShare = total > 0 ? tax / total : 0;
        const sale = at(o.processedAt);
        if (sale) { sale.orders += 1; sale.gross += total; sale.discounts += num(o.totalDiscountsSet); sale.tax += tax; sale.units += Number(o.currentSubtotalLineItemsQuantity) || 0; n++; }
        let refunded = 0;
        for (const r of o.refunds ?? []) {
          const amt = num(r.totalRefundedSet); refunded += amt;
          const day = at(r.createdAt); if (day) { day.refunds += amt; day.tax -= amt * taxShare; }
        }
        // A cancelled order that wasn't refunded in full: Shopify reverses the rest on the cancel day.
        if (o.cancelledAt && total - refunded > 0.005) { const day = at(o.cancelledAt); if (day) { day.refunds += total - refunded; day.tax -= (total - refunded) * taxShare; } }
      }
      after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
    } while (after);

    // Days with no orders still count as 0.
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const rows = [];
    for (let t = new Date(firstDay + 'T12:00:00Z'); fmt.format(t) <= fmt.format(new Date()); t = new Date(t.getTime() + 864e5)) {
      const a = agg.get(fmt.format(t)) ?? blank(fmt.format(t));
      rows.push({ ...a, gross: r2(a.gross), refunds: r2(a.refunds), discounts: r2(a.discounts), tax: r2(a.tax), synced_at: new Date().toISOString() });
    }
    const { error } = await sb.from('shop_days').upsert(rows, { onConflict: 'day' });
    if (error) throw new Error(error.message);
    return json({ ok: true, orders: n, days: rows.length, timezone: tz });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
