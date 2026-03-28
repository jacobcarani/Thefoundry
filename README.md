# The Foundry

## Current Architecture
- Frontend: React + Vite + Three.js
- Backend: Flask API running in Docker on top of `dolfinx/dolfinx:stable`
- FEA runtime: FEniCSx containerized service exposed on port `5000`

## Docker Backend (Flask + FEniCSx)
1. Create `.env` at repo root:
   - `GEMINI_API_KEY=your_key_here`
2. Start backend container:
   - `docker compose up --build`
3. Backend base URL:
   - `http://localhost:5000`

## Frontend
1. In `frontend` folder:
   - `npm install`
   - `npm run dev`
2. Open:
   - `http://localhost:5173`

## API Routes
- `POST /api/upload`
- `GET /api/uploads/<filename>`
- `POST /api/parse_forces`
- `POST /api/run_simulation`
- `POST /api/run_agent_pipeline`

## Frontend Simulation Flow
1. Upload STL to `/api/upload`
2. Paint force regions on STL
3. Enter plain English force description
4. Run Simulation:
   - Calls `/api/parse_forces`
   - Shows parsed force confirmation
   - Calls `/api/run_agent_pipeline`
5. Stress field response is mapped onto mesh vertices using nearest-point lookup and a blue->red gradient
6. AI redesign recommendations and iteration number are returned with simulation results
