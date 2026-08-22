# AI Commerce Layer

Phase 1 foundation for the Razorpay Buildathon "AI Commerce Layer" project. This phase only sets up the base frontend/backend/database plumbing — no business features yet.

## Structure

```
ai-commerce-layer/
├── frontend/   # React + Vite (JavaScript)
└── backend/    # Node.js + Express, Prisma (PostgreSQL)
```

## Prerequisites

- Node.js 18+
- A running PostgreSQL instance

## Backend setup

```bash
cd backend
npm install
cp .env.example .env
# edit .env and set DATABASE_URL to your PostgreSQL connection string
npm run prisma:generate
npm run dev
```

The server starts on `http://localhost:4000` by default (configurable via `PORT` in `.env`).

Check it's working:

```bash
curl http://localhost:4000/api/health
```

This returns a JSON status, including whether the database connection succeeded.

## Frontend setup

```bash
cd frontend
npm install
npm run dev
```

The frontend starts on the default Vite dev server port (`http://localhost:5173`).

By default the frontend calls the backend at `http://localhost:4000`. If your backend runs on a different URL, copy `.env.example` to `.env` in `frontend/` and set `VITE_API_BASE_URL` accordingly.

On load, the frontend displays a minimal status page ("AI Commerce Layer") showing whether the backend and database are Connected or Disconnected, based on the backend's `/api/health` response.

## Notes

- No Prisma models exist yet — the database health check runs a plain `SELECT 1` query, so no migrations are required for Phase 1.
- No authentication, AI, scraping, inventory, merchant, or payment features are implemented in this phase.
