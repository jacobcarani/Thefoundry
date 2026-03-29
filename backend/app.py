import json
import math
import os
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from core import run_agent_pipeline
from utils import SessionLogger
from core.pipeline import run_fenicsx_simulation

BASE_DIR = Path(__file__).resolve().parent
REPO_DIR = BASE_DIR.parent
UPLOAD_DIR = BASE_DIR / "uploads"
MODELS_DIR = BASE_DIR / "models"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
CORS(app)
session_logger = SessionLogger(BASE_DIR / "session_log.json")
session_logger.log("App started", {})


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/api/upload")
def upload_file():
    file = request.files["file"]
    source_path = UPLOAD_DIR / file.filename
    file.save(source_path)
    return jsonify({"filename": file.filename})


@app.get("/api/uploads/<path:filename>")
def serve_upload(filename: str):
    return send_from_directory(UPLOAD_DIR, filename)


@app.post("/api/run_simulation")
def run_simulation():
    payload = request.get_json()
    stl_filename = payload.get("stl_filename")
    forces = payload.get("forces", [])
    resolution = payload.get("resolution", "high")
    part_context = payload.get("part_context", {})
    
    stl_path = UPLOAD_DIR / stl_filename or MODELS_DIR / stl_filename
    result = run_fenicsx_simulation(
        stl_path=stl_path,
        forces=forces,
        resolution=resolution,
        part_context=part_context,
    )
    return jsonify(result)


@app.post("/api/run_agent_pipeline")
def run_agent_pipeline_endpoint():
    payload = request.get_json()
    stl_filename = payload.get("stl_filename")
    forces = payload.get("forces", [])
    resolution = payload.get("resolution", "high")
    part_context = payload.get("part_context", {})
    session_id = payload.get("session_id", "default-session")
    painted_faces = payload.get("painted_faces", [])

    result = run_agent_pipeline(
        stl_filename=stl_filename,
        forces=forces,
        resolution=resolution,
        part_context=part_context,
        session_id=session_id,
        painted_faces=painted_faces,
    )
    return jsonify(result)


if __name__ == "__main__":
    app.run(debug=False, host="127.0.0.1", port=5000)