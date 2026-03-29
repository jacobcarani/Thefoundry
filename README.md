# The Foundry: FEA Simulation Engine

A minimal FEA (Finite Element Analysis) simulation engine for 3D model analysis. Accepts STL files, applies loads, and computes stress approximations using a synthetic solver fallback.

## Features

### Basic File Upload
*   Accepts `.stl` file format.

### Simple FEA Execution
*   Runs stress simulation on uploaded STL models.
*   Returns max/min stress values and safety factor calculation.

### Synthetic Fallback Solver
*   Fallback stress approximation when FEniCSx is unavailable.
*   Basic computational geometry for mesh handling.

### Session Logging
*   Basic logging of simulation runs to `session_log.json`.

## Tech Stack

### Backend
*   **Framework**: Flask
*   **FEA**: Synthetic stress solver (gmsh for mesh, numpy for calculations)
*   **Database**: SQLite for logging

### Frontend
*   **Framework**: React.js
*   **3D Graphics**: Three.js
*   **Build Tool**: Vite

## How It Works

1. User uploads an STL file
2. Backend processes file and stores it
3. Simulation runs using synthetic stress solver
4. Results returned with max stress and safety factor

## Architecture Notes

Multi-agent pipeline attempted but incomplete. SimpleAgent currently handles simulation execution.

## Setup

1. Clone the repository
2. Install backend: `pip install Flask numpy gmsh`
3. Install frontend: `npm install`
4. Run backend: `python backend/app.py`
5. Run frontend: `cd frontend && npm run dev`

## Notes

This is a minimal FEA engine. Multi-agent pipeline architecture is under development but not fully functional. Redesign agents, calibration, and advanced geometry analysis are not yet implemented.