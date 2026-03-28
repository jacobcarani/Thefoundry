import json
import math
import os
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from core import run_agent_pipeline
from utils import load_calibration_state, convert_step_to_stl, preprocess_stl, triangle_count, SessionLogger
from core.pipeline import parse_forces_with_gemini, run_fenicsx_simulation

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
REPO_DIR = BASE_DIR.parent
UPLOAD_DIR = BASE_DIR / "uploads"
MODELS_DIR = BASE_DIR / "models"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)
SESSION_LOG_PATH = REPO_DIR / "Hackathon-yconic" / "foundry" / "logs" / "session_log.json"

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": ["http://localhost:5173", "http://127.0.0.1:5173"]}})
session_logger = SessionLogger(SESSION_LOG_PATH)
session_logger.log("App started", {"message": "Flask app booted"})

# Load default test model on startup.
DEFAULT_MODEL_PATH = MODELS_DIR / "MOUSQUETON_default.stl"
if DEFAULT_MODEL_PATH.exists():
    session_logger.log("Default model available", {"path": DEFAULT_MODEL_PATH.name})


def _run_calibration_subprocess(iterations: int, resolution: str) -> dict:
    cmd = [
        sys.executable,
        "calibrate_fea.py",
        "--iterations",
        str(int(iterations)),
        "--resolution",
        str(resolution),
        "--json",
    ]
    completed = subprocess.run(
        cmd,
        cwd=BASE_DIR,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "calibration subprocess failed").strip()
        raise RuntimeError(detail)

    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("Calibration subprocess returned no output")

    return json.loads(lines[-1])


def _safe_json_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/api/upload")
def upload_file():
    file = request.files.get("file")
    resolution = request.form.get("resolution", "high")
    if file is None or file.filename is None or file.filename.strip() == "":
        return jsonify({"error": "No file provided"}), 400

    source_path = UPLOAD_DIR / file.filename
    file.save(source_path)

    source_ext = source_path.suffix.lower()
    if source_ext in {".step", ".stp"}:
        stl_filename = f"{source_path.stem}.stl"
        stl_path = UPLOAD_DIR / stl_filename
        try:
            convert_step_to_stl(source_path, stl_path)
        except Exception as exc:
            return jsonify({"error": f"Failed to convert STEP to STL: {str(exc)}"}), 400
        model_path = stl_path
        source_format = "step"
    elif source_ext == ".stl":
        model_path = source_path
        source_format = "stl"
    else:
        return jsonify({"error": "Unsupported file type. Upload .stl, .step, or .stp"}), 400

    if source_format == "step" and str(resolution).lower() == "low":
        tri_count = triangle_count(model_path)
        preprocess_info = {
            "mesh_repaired": False,
            "mesh_refined": False,
            "triangle_count_before": tri_count,
            "triangle_count_after": tri_count,
            "resolution_used": "low",
            "fast_preview": True,
        }
    else:
        preprocess_info = preprocess_stl(model_path, resolution)

    session_logger.log("Model loaded", {"filename": file.filename, "render_filename": model_path.name})
    return jsonify({
        "filename": model_path.name,
        "original_filename": file.filename,
        "source_format": source_format,
        "mesh_repaired": bool(preprocess_info.get("mesh_repaired", False)),
        "triangle_count_before": int(preprocess_info.get("triangle_count_before", 0)),
        "triangle_count_after": int(preprocess_info.get("triangle_count_after", 0)),
        "mesh_refined": bool(preprocess_info.get("mesh_refined", False)),
        "fast_preview": bool(preprocess_info.get("fast_preview", False)),
        "resolution_used": preprocess_info.get("resolution_used", resolution),
    })


@app.get("/api/uploads/<path:filename>")
def serve_upload(filename: str):
    return send_from_directory(UPLOAD_DIR, filename)


@app.post("/api/parse_forces")
def parse_forces():
    payload = request.get_json(silent=True) or {}
    description = payload.get("description", payload.get("force_description", ""))
    faces = payload.get("faces", payload.get("painted_faces", []))
    part_context = payload.get("part_context", {})

    if not description:
        return jsonify({"error": "description is required"}), 400

    try:
        session_logger.log(
            "Force description entered",
            {
                "raw_text": description,
                "painted_face_count": len(faces),
            },
        )

        structured_forces = parse_forces_with_gemini(
            description=description,
            faces=faces,
            api_key=os.getenv("GEMINI_API_KEY", ""),
            part_context=part_context,
        )

        session_logger.log(
            "Forces parsed",
            {
                "structured_force_count": len(structured_forces),
            },
        )
        return jsonify(structured_forces)
    except Exception as exc:
        return jsonify({"error": f"Failed to parse forces: {str(exc)}"}), 500


@app.post("/api/run_simulation")
def run_simulation():
    payload = request.get_json(silent=True) or {}
    stl_filename = payload.get("stl_filename")
    forces = payload.get("forces", payload.get("structured_forces", []))
    resolution = payload.get("resolution", "high")
    part_context = payload.get("part_context", {})

    if not stl_filename:
        return jsonify({"error": "stl_filename is required"}), 400

    stl_path = UPLOAD_DIR / stl_filename
    if not stl_path.exists():
        return jsonify({"error": "STL file not found"}), 404

    try:
        session_logger.log(
            "Simulation started",
            {
                "resolution": resolution,
                "stl_filename": stl_filename,
                "structured_force_count": len(forces),
                "material": part_context.get("material", "unknown"),
            },
        )

        result = run_fenicsx_simulation(
            stl_path=stl_path,
            forces=forces,
            resolution=resolution,
            part_context=part_context,
        )

        # One-time bootstrap calibration: calibrate once to set up app correctly,
        # then keep simulation behavior stable.
        solver_name = str(result.get("solver", ""))
        if solver_name.startswith("synthetic_fallback"):
            try:
                calibration_state = load_calibration_state()
                is_calibrated = bool(calibration_state.get("last_calibration_utc"))

                if not is_calibrated:
                    calibration_result = _run_calibration_subprocess(iterations=2, resolution=resolution)
                    result["auto_calibration"] = {
                        "ran": True,
                        "mode": "bootstrap_once",
                        "synthetic_target_pa": calibration_result.get("synthetic_target_pa"),
                        "last_calibration_utc": calibration_result.get("last_calibration_utc"),
                    }
                else:
                    result["auto_calibration"] = {
                        "ran": False,
                        "mode": "bootstrap_once",
                        "reason": "already_calibrated",
                        "last_calibration_utc": calibration_state.get("last_calibration_utc"),
                    }
            except Exception as calibration_exc:
                result["auto_calibration"] = {
                    "ran": False,
                    "mode": "bootstrap_once",
                    "warning": str(calibration_exc),
                }

        session_logger.log(
            "Simulation completed",
            {
                "max_stress": result.get("max_stress"),
                "min_stress": result.get("min_stress"),
                "safety_factor": result.get("safety_factor"),
                "pass_fail": "PASS" if result.get("passed") else "FAIL",
            },
        )

        session_logger.log(
            "Report generated",
            {
                "summary": {
                    "max_stress": result.get("max_stress"),
                    "min_stress": result.get("min_stress"),
                    "safety_factor": result.get("safety_factor"),
                    "verdict": "PASS" if result.get("passed") else "FAIL",
                }
            },
        )
        return jsonify(result)
    except Exception as exc:
        return jsonify({"error": f"Simulation failed: {str(exc)}"}), 500


@app.post("/api/run_agent_pipeline")
def run_agent_pipeline_endpoint():
    payload = request.get_json(silent=True) or {}
    stl_filename = payload.get("stl_filename")
    forces = payload.get("forces", payload.get("structured_forces", []))
    resolution = payload.get("resolution", "high")
    part_context = payload.get("part_context", {})
    session_id = str(payload.get("session_id", "")).strip()
    painted_faces = payload.get("painted_faces", [])

    if not stl_filename:
        return jsonify({"error": "stl_filename is required"}), 400
    if not session_id:
        return jsonify({"error": "session_id is required"}), 400

    stl_path = UPLOAD_DIR / stl_filename
    if not stl_path.exists():
        return jsonify({"error": "STL file not found"}), 404

    try:
        session_logger.log(
            "Agent pipeline started",
            {
                "session_id": session_id,
                "resolution": resolution,
                "stl_filename": stl_filename,
                "structured_force_count": len(forces),
                "material": part_context.get("material", "unknown"),
            },
        )

        result = run_agent_pipeline(
            stl_filename=stl_filename,
            forces=forces,
            resolution=resolution,
            part_context=part_context,
            session_id=session_id,
            painted_faces=painted_faces,
        )

        session_logger.log(
            "Agent pipeline completed",
            {
                "session_id": session_id,
                "iteration_number": result.get("iteration_number", 1),
                "max_stress": result.get("max_stress"),
                "safety_factor": _safe_json_number(result.get("safety_factor")),
                "recommendation_count": len(result.get("redesign_recommendations", [])),
            },
        )
        return jsonify(result)
    except Exception as exc:
        return jsonify({"error": f"Agent pipeline failed: {str(exc)}"}), 500


@app.post("/api/calibrate_fea")
def calibrate_fea():
    payload = request.get_json(silent=True) or {}
    resolution = payload.get("resolution", "high")
    iterations = payload.get("iterations", 3)

    try:
        result = _run_calibration_subprocess(iterations=iterations, resolution=resolution)
        session_logger.log(
            "FEA calibration completed",
            {
                "iterations": result.get("iterations"),
                "synthetic_target_pa": result.get("synthetic_target_pa"),
            },
        )
        return jsonify(result)
    except Exception as exc:
        return jsonify({"error": f"Calibration failed: {str(exc)}"}), 500


@app.post("/api/log_event")
def log_event():
    payload = request.get_json(silent=True) or {}
    event_type = payload.get("event_type")
    data = payload.get("data", {})

    if not event_type:
        return jsonify({"error": "event_type is required"}), 400

    session_logger.log(event_type, data)
    return jsonify({"ok": True})


@app.get("/api/session_log")
def get_session_log():
    return jsonify({
        "session_id": session_logger.session_id,
        "entries": session_logger.get_entries(),
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)