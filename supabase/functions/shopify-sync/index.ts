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

const ORDERS = `query($q: String!, $after: String) {
  orders(first: 250, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      createdAt test cancelledAt
      totalPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      currentSubtotalLineItemsQuantity
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

    // Re-pull the last few days every time (refunds land late); first run goes back as far as Shopify allows (about 60 days).
    const { data: last } = await sb.from('shop_days').select('day').order('day', { ascending: false }).limit(1);
    const days = Math.min(Number(body.days) || (last && last.length ? 4 : 60), 60);
    const since = new Date(Date.now() - days * 864e5).toISOString();

    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const agg = new Map<string, { day: string; orders: number; gross: number; refunds: number; discounts: number; units: number }>();
    let after: string | null = null, n = 0;
    do {
      const d = await gql(shop, token, ORDERS, { q: `created_at:>='${since}'`, after });
      for (const o of d.orders.nodes) {
        if (o.test || o.cancelledAt) continue;
        const day = fmt.format(new Date(o.createdAt));
        const a = agg.get(day) ?? { day, orders: 0, gross: 0, refunds: 0, discounts: 0, units: 0 };
        a.orders += 1;
        a.gross += Number(o.totalPriceSet.shopMoney.amount) || 0;
        a.refunds += Number(o.totalRefundedSet.shopMoney.amount) || 0;
        a.discounts += Number(o.totalDiscountsSet.shopMoney.amount) || 0;
        a.units += Number(o.currentSubtotalLineItemsQuantity) || 0;
        agg.set(day, a); n++;
      }
      after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
    } while (after);

    // Days with no orders still count as 0.
    const firstDay = fmt.format(new Date(since));
    const rows = [];
    for (let t = new Date(firstDay + 'T12:00:00Z'); fmt.format(t) <= fmt.format(new Date()); t = new Date(t.getTime() + 864e5)) {
      const day = fmt.format(t);
      const a = agg.get(day) ?? { day, orders: 0, gross: 0, refunds: 0, discounts: 0, units: 0 };
      rows.push({ ...a, gross: Math.round(a.gross * 100) / 100, refunds: Math.round(a.refunds * 100) / 100, discounts: Math.round(a.discounts * 100) / 100, synced_at: new Date().toISOString() });
    }
    const { error } = await sb.from('shop_days').upsert(rows, { onConflict: 'day' });
    if (error) throw new Error(error.message);
    return json({ ok: true, orders: n, days: rows.length, timezone: tz });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
