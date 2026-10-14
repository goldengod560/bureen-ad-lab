-- Bureen Ad Lab: database setup
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run.
-- Safe to run again: it won't duplicate anything.

create extension if not exists "pgcrypto";

-- The ads table is named "creatives": ad blockers block web addresses containing /ads?id=.
-- (Renames the old table if this project was set up before that change.)
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ads') then
    alter table public.ads rename to creatives;
  end if;
end $$;

-- Products: one row per product tab (Crew Neck, V-Neck, ...)
create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  subtitle    text default '6-Pack',
  kind        text not null default 'crew',           -- crew | vneck | long | thermal | tank | other
  sort        int  not null default 0,
  rules       jsonb not null default '{}'::jsonb,      -- testing rules, editable per product
  economics   jsonb not null default '{}'::jsonb,      -- price, costs, break-even, average order
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Ads: every creative version. One row per version (V1, V2...).
create table if not exists creatives (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references products(id) on delete cascade,
  concept       text,                                  -- e.g. "Value: $6 per shirt"
  base_name     text not null,                         -- name as it appears in Ads Manager
  version       int  not null default 1,
  parent_id     uuid references creatives(id) on delete set null,
  format        text not null default 'image',         -- image | video | carousel
  angle         text,
  offer         text,
  headline      text,
  primary_text  text,
  notes         text,
  media_path    text,                                  -- path in the ad-media storage bucket
  media_type    text,                                  -- image/png, video/mp4 ...
  stage         text not null default 'untested',      -- untested | testing | bench | main | exhausted | mid | failed | seasonal | retired
  result        text,                                  -- pass | strong_pass | mid | insufficient | fail | unfair | held | not_held
  launched_on   date,                                  -- first day of spend in Meta
  setup_era     text,                                  -- era1 (to Dec 2025) | era2 (Jan-Aug 2026) | era3 (Sep 2026 on)
  tags          jsonb not null default '{}'::jsonb,    -- hook, background, text amount, person/product...
  history       jsonb not null default '{}'::jsonb,    -- imported lifetime stats and Yasin's notes
  created_at    timestamptz not null default now()
);
create index if not exists ads_product_idx on creatives(product_id);
create index if not exists ads_stage_idx on creatives(stage);

-- Tests: a Stage 1 test or a Stage 2 (Main) run of one ad
create table if not exists tests (
  id             uuid primary key default gen_random_uuid(),
  ad_id          uuid not null references creatives(id) on delete cascade,
  product_id     uuid not null references products(id) on delete cascade,
  stage          int  not null default 1,
  start_date     date,
  planned_days   int  not null default 7,
  budget         numeric,
  conditions     jsonb not null default '{}'::jsonb,   -- landing page version, enhancements on/off, shop ads...
  status         text not null default 'active',       -- active | complete | stopped
  result         text,
  strong         boolean default false,
  result_reason  text,
  override_reason text,
  created_at     timestamptz not null default now()
);
create index if not exists tests_ad_idx on tests(ad_id);

-- Check-ins: cumulative numbers at day 3, day 7, etc.
create table if not exists checkpoints (
  id           uuid primary key default gen_random_uuid(),
  test_id      uuid not null references tests(id) on delete cascade,
  day          int  not null,
  spend        numeric,
  purchases    numeric,
  revenue      numeric,
  impressions  numeric,
  link_clicks  numeric,
  adds_to_cart numeric,
  checkouts    numeric,
  frequency    numeric,
  hook_plays   numeric,                                -- 3-second video plays
  last3_purchases numeric,
  notes        text,
  source       text default 'manual',                  -- manual | file
  created_at   timestamptz not null default now(),
  unique (test_id, day)
);

-- Daily numbers per ad, from the Ads Manager files you drop in (named meta_days, not ad_days, to dodge ad blockers)
drop table if exists ad_days;
create table if not exists meta_days (
  id           uuid primary key default gen_random_uuid(),
  ad_name      text not null,
  adset        text not null default '',
  campaign     text not null default '',
  day          date not null,
  spend        numeric, impressions numeric, reach numeric, frequency numeric,
  link_clicks  numeric, adds_to_cart numeric, checkouts numeric,
  purchases    numeric, revenue numeric, hook_plays numeric,
  imported_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (ad_name, adset, campaign, day)
);
create index if not exists meta_days_day_idx on meta_days(day);

-- Daily store totals pulled from Shopify (read-only)
create table if not exists shop_days (
  day          date primary key,
  orders       int not null default 0,
  gross        numeric not null default 0,   -- total sales incl. shipping and tax, after discounts
  refunds      numeric not null default 0,
  discounts    numeric not null default 0,
  units        int not null default 0,
  synced_at    timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- Change log: site, stock, offer, tracking, Meta changes
create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid references products(id) on delete cascade,  -- null = whole store
  day         date not null,
  kind        text not null,
  note        text,
  created_at  timestamptz not null default now()
);

-- Decision journal: launches, kills, budget calls, alarm answers
create table if not exists decisions (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid references products(id) on delete cascade,
  ad_id       uuid references creatives(id) on delete set null,
  test_id     uuid references tests(id) on delete set null,
  day         date not null default current_date,
  kind        text not null,                          -- launch | kill | budget | alarm | move
  choice      text,
  reason      text,
  created_at  timestamptz not null default now()
);

-- Learnings
create table if not exists learnings (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid references products(id) on delete cascade,
  day         date not null default current_date,
  kind        text not null default 'learning',       -- learning | hypothesis | rule_change
  text        text not null,
  source      text,
  created_at  timestamptz not null default now()
);

-- Security: only signed-in users can read or write. You will be the only user.
do $$
declare t text;
begin
  foreach t in array array['products','creatives','tests','checkpoints','meta_days','shop_days','events','decisions','learnings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "signed in full access" on %I', t);
    execute format('create policy "signed in full access" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- API access: only signed-in users can touch the tables. The public (anon) key gets nothing.
-- Needed because "Automatically expose new tables" is turned off for this project.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on all tables in schema public from anon;

-- Private storage for ad images and videos
insert into storage.buckets (id, name, public, file_size_limit)
values ('ad-media', 'ad-media', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "signed in media access" on storage.objects;
create policy "signed in media access" on storage.objects
  for all to authenticated
  using (bucket_id = 'ad-media') with check (bucket_id = 'ad-media');

-- Starting products (rules and costs get filled in by the app)
insert into products (name, kind, sort)
select * from (values
  ('Crew Neck', 'crew', 1),
  ('V-Neck', 'vneck', 2),
  ('Long Sleeve', 'long', 3),
  ('Thermal', 'thermal', 4),
  ('Tank Top', 'tank', 5)
) as v(name, kind, sort)
where not exists (select 1 from products);
