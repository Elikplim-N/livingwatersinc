# Environment Variables Setup

## Backend (.env in `/server` folder)

```env
# PostgreSQL Database
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/postgres?sslmode=disable

# JWT Secret (change in production!)
JWT_SECRET=replace-with-a-long-random-secret

# Server Port
PORT=3000

# Environment
NODE_ENV=development
```

## Frontend (no .env needed for HTML version)

The HTML version reads these from the code:
- **API URL**: `/api` in production, `http://localhost:3000/api` locally (see `API_URL` in `index.html`)
- **MapTiler Key**: Currently using free OpenStreetMap (no key needed)

If you want to use MapTiler tiles:
1. Get free API key: https://www.maptiler.com/
2. Replace OpenStreetMap URL in `index.html`

## For Vercel Deployment

### Backend Environment Variables (set in Vercel dashboard):
```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/postgres?sslmode=disable
JWT_SECRET=replace-with-a-long-random-secret
```

### Frontend:
The API is deployed alongside the frontend as a Vercel serverless function
(`api/index.ts`), so `index.html` calls `/api` on the same domain — no URL to update.

## Quick Setup

1. **Copy the env files:**
```bash
# Backend
cd server
cp .env.example .env
# Edit .env with your values

# Frontend (HTML version)
# No .env needed - edit index.html directly
```

2. **Start the servers:**
```bash
# Backend
cd server
npm install
npm run dev

# Frontend  
cd ..
python3 -m http.server 8888
```

3. **Access:**
- Frontend: http://localhost:8888
- Backend: http://localhost:3000
- Login: admin@kaneshie.com / admin123

## Current Values

Your current setup uses:
- **Database**: set via `DATABASE_URL`
- **Backend**: Port 3000
- **Frontend**: Port 8888
- **Maps**: OpenStreetMap (free, no key needed)
