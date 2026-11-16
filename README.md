# LWI Street Tracker

A map-based outreach tracker for Living Waters Incorporated. Teams pin the streets they cover, log each visit (people reached, converts, follow-ups, team and notes), and see coverage at a glance.

## Features

- **Admin-only sign in** (email + password), stays signed in for 30 days
- **Live map** (dark theme) with clustered pins: green = visited in the last 30 days, blue = visited earlier, grey = not visited yet
- **Kaneshie Division boundary** (Darkuman + Kaneshie districts) drawn on the map; everything outside is dimmed
- **Dashboard stats** for the division: streets, % reached, people reached, converts, with a coverage bar. *Reached* = streets inside the division with at least one visit ÷ all streets inside the division
- **Load all streets in the division** (admin): one click pulls every named street inside the boundary from OpenStreetMap, so the % is out of the real total
- **Search, filter** (all / visited / not visited) and **sort** (A–Z, recent, needs visit, most converts)
- **Street detail** with full visit history, totals, "show on map" and Google Maps directions
- **Add streets** by tapping the map or using GPS; street name and district are filled in automatically
- **Log visits** with date, reached, converts, follow-ups, team members (remembered) and notes
- **Delete** visits (your own, or any as admin) and streets (admin only), with confirmation
- Works on phones (bottom-sheet forms, safe-area aware) and desktop

## Qodesh centre

The map opens centred on a **Qodesh** pin (5.5880, -0.2301). To make it exact, stand at Qodesh and use **Admin → Map centre → use my GPS**. The street list can be sorted by **Nearest Qodesh**.

## Mapbox Studio style (optional)

1. Create a free account at mapbox.com, design a style in **Mapbox Studio**, then **Share**.
2. Copy the **Style URL** (`mapbox://styles/you/xxxx`) and your **Default public token** (`pk.…`).
3. Paste both in **Admin → Map style**. A **Mapbox** option appears in the map style switcher and becomes the default.

## Field collectors (no password)

Share **`https://<your-app>/collect`** (Admin → Field collectors → Share). Collectors enter their **name and phone number once** and can record converts straight away:

- Full name, age, phone, street, where they live, notes
- Optional GPS (one tap, shows accuracy). It can also be added later when someone visits back
- Works on a weak signal: entries save on the phone and send automatically when online (no duplicates)
- New phone? Enter the same phone number and their entries come back

The admin sees every convert with who collected it, can follow up (call, WhatsApp, directions, "Visited back" + capture GPS), edit, delete and export to CSV.

## Project layout

```
index.html          Admin app (vanilla JS + Leaflet)
collect.html        Field collector app (/collect), no dependencies
app.css             Prebuilt Tailwind CSS (regenerate with `npm run build:css`)
api/index.ts        Vercel serverless API (/api/*)
division.geojson    Kaneshie Division + Darkuman/Kaneshie district boundaries
db/schema.sql       Database tables
scripts/db-setup.mjs  Creates tables and user accounts
```

## Deploy (Vercel)

1. Create a PostgreSQL database (Supabase, Neon, Railway, etc.).
2. Set up the tables and your first admin account:
   ```bash
   npm install
   DATABASE_URL="postgresql://..." npm run db:setup -- admin@example.com "Admin Name" "a-strong-password" admin
   ```
   Only **admin** accounts can sign in. Run the command again to add another admin, or with an existing email to reset that password.
3. In Vercel, import this repo and set the environment variables `DATABASE_URL` and `JWT_SECRET` (see `.env.example`).
4. Deploy. The frontend and API are served from the same domain — no URLs to configure.
5. Sign in as admin and tap **Load all streets in Kaneshie Division** once.

## First-time setup (no computer needed)

Open the deployed app. If the database has no admin yet, it shows **"Create the admin"**: the app creates all tables, clears any old data and makes that the single admin login.

Already have an admin? Sign in, open **⚙ Admin settings** to change your name/email/password, or use **Reset all data** to delete every street, visit and other account (only you remain).

Locked out? Set a `SETUP_KEY` environment variable in Vercel and POST `{ email, full_name, password, setup_key }` to `/api/setup` to wipe everything and create a new admin.

## Start fresh (one admin, no data)

Deletes every street, visit and account, creates any missing tables, and leaves a single admin login:

```bash
DATABASE_URL="postgresql://..." npm run db:reset -- admin@example.com "Admin Name" "a-strong-password"          # preview
DATABASE_URL="postgresql://..." npm run db:reset -- admin@example.com "Admin Name" "a-strong-password" --yes    # do it
```

## Division boundary

`division.geojson` was traced from the Ghana Police Service *Jurisdictional Map of Kaneshie Division* (2021) using the map's coordinate grid, so edges are accurate to roughly 50–100 m. To adjust it, edit the coordinates (`[longitude, latitude]`) in that file, e.g. at https://geojson.io.

## Local development

```bash
npm install
npx vercel dev
```

Then open the URL it prints. Requires a `.env` file with `DATABASE_URL` and `JWT_SECRET`.

If you change Tailwind classes in `index.html`, rebuild the stylesheet:

```bash
npm run build:css
```

## API

All endpoints except login need `Authorization: Bearer <token>`.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | Current user |
| GET | `/api/streets` | All streets with their visits |
| POST | `/api/streets` | `{ name, district, latitude, longitude }` |
| POST | `/api/streets/import` | Admin only. `{ streets: [{ name, district, osm_ids, geometry, length_m }] }`, skips existing name+district |
| DELETE | `/api/streets/:id` | Admin only |
| POST | `/api/visits` | `{ street_id, visit_date, attendance, decisions, follow_ups, team_members[], notes }` |
| DELETE | `/api/visits/:id` | |
