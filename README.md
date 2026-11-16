# LW Inc. Street Campaign

A map-based outreach tracker for Living Waters Incorporated. Teams pin the streets they cover, log each visit (people reached, converts, follow-ups, team and notes), and see coverage at a glance.

## Features

- **Admin-only sign in** (email + password), stays signed in for 30 days
- **Mapbox GL JS map** with flag markers: red = not visited, green = visited, blue (big soft pulse) = up next; visited flags pulse gently. Filters and search show only matching streets on the map
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

## Map: Mapbox GL JS + Overpass GeoJSON

The map runs on **Mapbox GL JS** (vector, GPU-rendered). Streets come from **Overpass** (OpenStreetMap), are converted to **GeoJSON**, stored in the database, and drawn as GeoJSON line + point layers coloured by visit status. Converts, the division border and the Qodesh pin are layers or markers on top.

**Setup (free tier: about 50,000 map loads a month):**
1. Create an account at mapbox.com and copy your **Default public token** (`pk.…`). In the token settings, restrict it to your site's URL.
2. In Vercel → your project → **Settings → Environment Variables**, add `MAPBOX_TOKEN` = your `pk.…` token (all environments), then **redeploy**. The token is only read from this variable.
3. Optional: design a style in **Mapbox Studio** → **Share**, copy the **Style URL** (`mapbox://styles/you/xxxx`) and paste it in **Admin → Map style** (or set `MAPBOX_STYLE` in Vercel). It becomes the default and appears as **Mapbox** in the style switcher next to Street / Satellite / Dark.

Until a token is set, the map shows a "Connect Mapbox" card; everything else in the app still works.

## Planning, focus and Street View

- **Up next:** on any street tap **Plan next**. Planned streets show a blue flag with a big soft pulse on the map and appear in the **Up next** list at the top of Streets. Logging a visit takes the street off the list automatically.
- **Focus:** selecting a street fades everything else so only that street stands out. Tap the map background or **All streets** to leave focus.
- **Street View / Google Earth:** every street has a **Street View** button that lets you choose **Google Street View** (inside the app with a Google key, otherwise in Google Maps) or **Google Earth** (3D satellite view; opens the Earth app if installed).

**Optional Google Street View inside the app:**
1. Go to https://console.cloud.google.com, create a project and enable **Maps Embed API** (free, no per-use cost).
2. **APIs & Services → Credentials → Create credentials → API key.** Restrict it to *Maps Embed API* and to your site's URL (HTTP referrers).
3. In Vercel add `GOOGLE_MAPS_KEY` = that key, then redeploy.

## Retention (who came to church after an outreach)

Converts from each outreach are followed up by two services:

- **Qodesh City Church**: the Sunday after the outreach
- **Saturday Night Revival**: the following Saturday

On a street's visit history tap **Record attendance**. Type how many came (or use + and −), or tick the names of converts recorded for that outreach. Ticking names fills in the number, and names are never required. The service dates are worked out from the outreach date. Totals and percentages appear in **Converts → Retention**, and **By outreach** lists every outreach so attendance is quick to record. The CSV export includes whether each named convert came.

## Stage point & street rep

- **Stage point:** the exact spot on a street where the stage is mounted. The street's flag sits there. Set it from the street page with **GPS** (stand at the spot) or **Map** (tap the spot), or capture it while logging a visit. It always snaps onto the street line.
- **No duplicate streets:** when adding a street, if the point is on a street already in the app, you get **Set the stage point here** instead of a second copy.
- **Street rep:** optional name and phone of the person in charge of a street, with a Call button.

## Overview page for leaders (view only, no login)

**Admin → Overview link → Share** gives a link like `https://<your-app>/overview?k=…`. Opening it shows a read-only summary: streets reached, outreaches, people reached, converts, retention for Qodesh City Church and Saturday Night Revival, the map with flags, Up next, a breakdown by area and recent outreaches. It refreshes every minute and shows **totals only, never names or phone numbers**. Filter chips (All / Not visited / Up next / Visited) control the map, and tapping a flag gives Street View / Google Earth, Directions and Show on map. The link is permanent: it is created once and never changes.

## Install as an app (phones and computers)

All three pages can be installed like a normal app, with the logo as the icon, opening full screen:

- **Android / Chrome / Edge:** tap **Install app** (download icon); the browser asks to install.
- **iPhone / iPad:** tap **Install app** to see the steps: Safari **Share** → **Add to Home Screen** → **Add**.
- The installed **Overview** remembers its link on that device, so it opens straight in.

The Overview also has **Download → Save as PDF** (the whole page, A4) and **Download spreadsheet** (all streets + summary, opens in Excel).

## Field collectors (no password)

Share **`https://<your-app>/collect`** (Admin → Field collectors → Share). Collectors enter their **name and phone number once** and can record converts straight away:

- Full name, age, phone, street, where they live, notes
- Optional GPS (one tap, shows accuracy). It can also be added later when someone visits back
- Works on a weak signal: entries save on the phone and send automatically when online (no duplicates)
- New phone? Enter the same phone number and their entries come back

The admin sees every convert with who collected it, can follow up (call, WhatsApp, directions, "Visited back" + capture GPS), edit, delete and export to CSV.

## Project layout

```
index.html          Admin app (vanilla JS + Mapbox GL JS)
collect.html        Field collector app (/collect), no dependencies
overview.html       Read-only overview for leaders (/overview?k=…)
app.css             Prebuilt Tailwind CSS (regenerate with `npm run build:css`)
api/index.ts        Vercel serverless API (/api/*)
manifest-*.webmanifest, sw.js   Make the pages installable (app icon, full screen)
img/                Logo (transparent PNGs), favicon, phone home-screen icon
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
