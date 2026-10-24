# LWI Street Tracker

A GPS-powered street tracking application for Living Waters Incorporated outreach activities.

## Features

- 📍 **GPS Location Detection** - Automatically detect streets using device location
- 🗺️ **Interactive Map** - Leaflet-based map with marker clustering
- ➕ **Add Streets** - Click map or use GPS to add new streets
- 📝 **Log Visits** - Track date, attendance, and converts
- 📊 **Visual Tracking** - Streets colored by visit status
- 📱 **Responsive Design** - Collapsible sidebar, works on mobile & desktop
- 🌑 **Dark Theme** - Clean, modern UI

## Tech Stack

**Frontend:**
- Single HTML file (no build needed!)
- Tailwind CSS (CDN)
- Leaflet.js for maps
- Vanilla JavaScript

**Backend:** (see `backend` branch)
- Express + TypeScript
- PostgreSQL database
- JWT authentication
- Serverless-ready for Vercel

## Quick Start

### Local Development

1. **Start Backend:**
```bash
cd server
npm install
npm run dev
```

2. **Start Frontend:**
```bash
cd ../
python3 -m http.server 8888
```

3. **Open:** http://localhost:8888

### Login
- Email: `admin@kaneshie.com`
- Password: `admin123`

## Database Setup

Run migrations in `/supabase/migrations/`:
- `simple_init.sql` - Create tables
- `simple_functions.sql` - Helper functions

## Deployment

**Frontend:** Deployed to Vercel
- Production: https://kaneshie-simple.vercel.app

**Backend:** Can be deployed to:
- Vercel (serverless)
- Railway
- Render
- Any Node.js host

## Environment Variables

```env
# Backend
DATABASE_URL=postgresql://user:pass@host:port/db?sslmode=disable
JWT_SECRET=your-secret-key
PORT=3000
```

## Project Structure

```
/
├── index.html          # Main app (single file!)
├── vercel.json         # Vercel config
└── README.md

server/                 # Backend (separate branch)
├── src/
│   ├── routes/        # API endpoints
│   ├── middleware/    # Auth
│   └── db.ts          # Database
└── api/               # Serverless function
```

## API Endpoints

- `POST /api/auth/login` - Login
- `GET /api/streets` - List all streets
- `POST /api/streets` - Add new street
- `POST /api/visits` - Log a visit

## Features Roadmap

- [x] GPS-based street adding
- [x] Visit logging
- [x] Interactive map
- [x] Responsive design
- [ ] Edit visits
- [ ] Delete streets
- [ ] Photo uploads
- [ ] Offline mode
- [ ] Dashboard analytics

## License

MIT

## Credits

Built with ❤️ for Living Waters Incorporated
