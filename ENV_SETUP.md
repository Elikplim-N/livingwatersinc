# Environment Variables Setup

## Backend (.env in `/server` folder)

```env
# PostgreSQL Database
DATABASE_URL=postgresql://postgres:dgas0atnw2pd05y0@178.105.184.157:63400/postgres?sslmode=disable

# JWT Secret (change in production!)
JWT_SECRET=kaneshie-outreach-super-secret-jwt-key-2026

# Server Port
PORT=3000

# Environment
NODE_ENV=development
```

## Frontend (no .env needed for HTML version)

The HTML version reads these from the code:
- **API URL**: Set in `index.html` line ~180
- **MapTiler Key**: Currently using free OpenStreetMap (no key needed)

If you want to use MapTiler tiles:
1. Get free API key: https://www.maptiler.com/
2. Replace OpenStreetMap URL in `index.html`

## For Vercel Deployment

### Backend Environment Variables (set in Vercel dashboard):
```
DATABASE_URL=postgresql://postgres:dgas0atnw2pd05y0@178.105.184.157:63400/postgres?sslmode=disable
JWT_SECRET=kaneshie-outreach-super-secret-jwt-key-2026
```

### Frontend (update in code):
```javascript
const API_URL = 'https://your-backend-url.vercel.app/api';
```

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
- **Database**: `178.105.184.157:63400`
- **Backend**: Port 3000
- **Frontend**: Port 8888
- **Maps**: OpenStreetMap (free, no key needed)
