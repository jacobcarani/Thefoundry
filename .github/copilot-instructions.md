# The Foundry — Copilot Instructions

## What This Project Is
The Foundry is a multi-agent AI-powered structural engineering web app for solo engineers. It automates the iterative FEA (Finite Element Analysis) design loop. A user uploads a CAD part as an STL file, describes forces acting on it, runs a simulation, sees a stress heatmap, gets AI recommendations, and repeats until the part passes.

## Environment
- OS: Windows (development), Linux (NVIDIA DGX deployment later)
- Editor: VSCode
- Python virtual environment lives at `backend/venv`
- ALWAYS activate the venv before any Python command: `\.venv\Scripts\Activate.ps1`
- NEVER run pip or uvicorn without (venv) showing in the terminal

## Project Structure
```
root/
├── .github/copilot-instructions.md
├── backend/          # FastAPI Python app
│   ├── venv/
│   ├── main.py
│   └── uploads/
├── frontend/         # React + Vite app
└── docker/           # FEniCSx Docker container
```

## Tech Stack — Do Not Deviate From This
- **Frontend:** React, Vite, Three.js, @react-three/fiber, @react-three/drei
- **Backend:** FastAPI, Uvicorn, Python
- **FEA:** FEniCSx in Docker (image: dolfinx/dolfinx:stable)
- **AI/Agents:** LangGraph, Gemini API (swap to Ollama/LLaMA 3 on DGX later)
- **No new libraries without asking first**

## Current Milestone
Get one complete flow working end to end:
1. User uploads STL from the browser
2. FastAPI backend receives and saves it
3. Three.js renders it in the browser as a rotatable 3D model

Do not build beyond this until it is confirmed working.

## Rules
- Always activate venv before running any Python command
- Never use a different frontend framework than React + Vite
- Never use a different backend framework than FastAPI
- Keep CORS enabled for http://localhost:5173
- Build incrementally — one stage at a time, confirm it works before moving on
- All file uploads save to backend/uploads/
- Keep the Docker container Linux-compatible at all times for DGX deployment