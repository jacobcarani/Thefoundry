# The Foundry - Quick Start

## Running the App

### Backend (Terminal 1)
```powershell
cd c:\Users\jcara\Desktop\Yconic Hackathon\backend

# ⚠️ IMPORTANT: ALWAYS ACTIVATE VENV FIRST
.\venv\Scripts\Activate.ps1

# Then start the server
python app.py
```

You should see:
```
* Running on http://127.0.0.1:5000
```

### Frontend (Terminal 2 - NEW window)
```powershell
cd c:\Users\jcara\Desktop\Yconic Hackathon\frontend
npm run dev
```

You should see:
```
VITE v8.0.3  ready in XXX ms
  ➜  Local:   http://localhost:5174/
```

### Browser
Open `http://localhost:5174/` → **MOUSQUETON will auto-load**

---

## Key Points
- ✅ venv MUST be activated (`.\venv\Scripts\Activate.ps1`)
- ✅ Backend runs on port 5000
- ✅ Frontend runs on port 5174 (or 5173 if available)
- ✅ Default model (MOUSQUETON steel carabiner) auto-loads on app startup
- ✅ You can now upload parts, add forces, and run FEA simulations

## Features Working
- [x] Default model auto-load (MOUSQUETON.STEP → .stl)
- [x] 3D viewport with Three.js
- [x] Force painting and annotation
- [x] FEA simulation pipeline
- [x] Stress visualization heatmap
- [x] Geometry feature extraction (thin walls, holes, corners)
- [x] Material yield-strength auto-lookup
- [x] RedesignAgent with Gemini recommendations
