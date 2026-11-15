# LWI Street Tracker

A map-based outreach tracker for Living Waters Incorporated. Teams pin the streets they cover, log each visit (people reached, converts, follow-ups, team and notes), and see coverage at a glance.

## Features

- **Sign-in screen** with saved sessions (30 days)
- **Live map** (dark theme) with clustered pins: green = visited in the last 30 days, blue = visited earlier, grey = not visited yet
- **Dashboard stats**: streets, % reached, people reached, converts, with a coverage bar
- **Search, filter** (all / visited / not visited) and **sort** (A–Z, recent, needs visit, most converts)
- **Street detail** with full visit history, totals, "show on map" and Google Maps directions
- **Add streets** by tapping the map or using GPS; street name and district are filled in automatically
- **Log visits** with date, reached, converts, follow-ups, team members (remembered) and notes
- **Delete** visits (your own, or any as admin) and streets (admin only), with confirmation
- Works on phones (bottom-sheet forms, safe-area aware) and desktop

## Project layout

```
index.html          The whole frontend (vanilla JS + Leaflet)
app.css             Prebuilt Tailwind CSS (regenerate with `npm run build:css`)
api/index.ts        Vercel serverless API (/api/*)
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
   Run the same command with `member` instead of `admin` to add team members (re-running it for an existing email resets that password).
3. In Vercel, import this repo and set the environment variables `DATABASE_URL` and `JWT_SECRET` (see `.env.example`).
4. Deploy. The frontend and API are served from the same domain — no URLs to configure.

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
| DELETE | `/api/streets/:id` | Admin only |
| POST | `/api/visits` | `{ street_id, visit_date, attendance, decisions, follow_ups, team_members[], notes }` |
| DELETE | `/api/visits/:id` | Your own visits, or any as admin |
