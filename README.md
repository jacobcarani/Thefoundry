# The Foundry

Milestone in progress:
1. Upload STL from browser
2. FastAPI backend receives and saves file
3. Three.js renders STL in browser

## Run Backend
1. Create venv at backend/venv
2. Activate on Windows PowerShell:
   - .\\venv\\Scripts\\Activate.ps1
3. Install dependencies:
   - pip install -r requirements.txt
4. Run server:
   - uvicorn main:app --reload --host 127.0.0.1 --port 8000

## Run Frontend
1. In frontend folder:
   - npm install
   - npm run dev
2. Open http://localhost:5173
