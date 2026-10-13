# Bureen Ad Lab

A private workspace for planning, tracking and filing Meta ad tests, one product at a time.

- Static site served by GitHub Pages; no build step (Preact + htm, vendored in `vendor/`).
- Data, images and videos live in Supabase behind a sign-in. Nothing about the business is stored in this repo.
- The app never connects to Meta. Ads are launched, paused and budgeted by hand in Ads Manager; the app only records what happened.

## Setup

1. In Supabase, run `supabase/schema.sql` in the SQL editor.
2. Create your user under Authentication → Users, then turn off new sign-ups.
3. Put the Project URL and the anon (publishable) key in `js/config.js`. Both are safe to publish; row-level security keeps the data private. Never put the service-role key here.
4. In GitHub, go to Settings → Pages and serve from `main`, root folder.

Open the site with `?mock=1` to try it with fake local data and no database.
