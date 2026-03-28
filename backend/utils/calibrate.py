import argparse
import json
from pathlib import Path

import numpy as np

from .benchmark import (
    cantilever_analytical_max_stress_pa,
    cantilever_force_payload,
    generate_cantilever_step,
)
from .calibration_store import apply_calibration_update, get_synthetic_target_pa, load_calibration_state
from core.pipeline import _get_volumetric_mesh_coordinates, _synthetic_stress
from .mesh import convert_step_to_stl, preprocess_stl

BASE_DIR = Path(__file__).resolve().parent.parent
UPLOADS_DIR = BASE_DIR / "uploads"
MODELS_DIR = BASE_DIR / "models"
BENCHMARK_STEP_PATH = UPLOADS_DIR / "benchmark_cantilever.step"
BENCHMARK_STL_PATH = UPLOADS_DIR / "benchmark_cantilever.stl"


def run_calibration_once(
    resolution: str = "high",
    force_n: float = 500.0,
    alpha: float = 0.35,
) -> dict:
    alpha = max(0.05, min(float(alpha), 0.95))

    meta = generate_cantilever_step(BENCHMARK_STEP_PATH)
    convert_step_to_stl(BENCHMARK_STEP_PATH, BENCHMARK_STL_PATH)
    preprocess_stl(BENCHMARK_STL_PATH, resolution)

    points = _get_volumetric_mesh_coordinates(BENCHMARK_STL_PATH, resolution)
    forces = cantilever_force_payload(meta, force_n)
    synthetic = _synthetic_stress(points, forces)

    synthetic_max = float(np.max(synthetic)) if len(synthetic) else 0.0
    analytical_max = cantilever_analytical_max_stress_pa(
        force_n=force_n,
        length_mm=meta["length_mm"],
        width_mm=meta["width_mm"],
        height_mm=meta["height_mm"],
    )

    current_target = get_synthetic_target_pa()

    if synthetic_max <= 1e-9:
        desired_target = current_target
    else:
        desired_target = current_target * (analytical_max / synthetic_max)

    new_target = (1.0 - alpha) * current_target + alpha * desired_target
    new_target = float(max(1.0e4, min(new_target, 2.0e9)))

    error_before_pct = 0.0
    if analytical_max > 1e-9:
        error_before_pct = abs(synthetic_max - analytical_max) / analytical_max * 100.0

    predicted_after = synthetic_max * (new_target / max(current_target, 1e-9))
    error_after_pct = 0.0
    if analytical_max > 1e-9:
        error_after_pct = abs(predicted_after - analytical_max) / analytical_max * 100.0

    calibration_info = {
        "resolution": resolution,
        "force_n": float(force_n),
        "alpha": alpha,
        "benchmark": {
            "step_file": BENCHMARK_STEP_PATH.name,
            "stl_file": BENCHMARK_STL_PATH.name,
            "length_mm": meta["length_mm"],
            "width_mm": meta["width_mm"],
            "height_mm": meta["height_mm"],
            "mesh_points": int(len(points)),
        },
        "analytical_max_stress_pa": float(analytical_max),
        "synthetic_max_stress_pa": float(synthetic_max),
        "error_before_percent": float(error_before_pct),
        "predicted_error_after_percent": float(error_after_pct),
        "target_before_pa": float(current_target),
        "target_after_pa": float(new_target),
    }

    state = apply_calibration_update(new_target, calibration_info)

    return {
        "ok": True,
        "calibration": calibration_info,
        "state": {
            "synthetic_target_pa": state["synthetic_target_pa"],
            "last_calibration_utc": state["last_calibration_utc"],
            "history_size": len(state.get("calibration_history", [])),
        },
    }


def run_calibration_iterations(iterations: int = 3, resolution: str = "high") -> dict:
    iterations = max(1, min(int(iterations), 10))
    last = None
    for _ in range(iterations):
        last = run_calibration_once(resolution=resolution)

    state = load_calibration_state()
    return {
        "ok": True,
        "iterations": iterations,
        "last": last,
        "synthetic_target_pa": state.get("synthetic_target_pa"),
        "last_calibration_utc": state.get("last_calibration_utc"),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run synthetic FEA calibration using benchmark STEP geometry.")
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--resolution", type=str, default="high")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    args = parser.parse_args()

    result = run_calibration_iterations(iterations=args.iterations, resolution=args.resolution)
    if args.json:
        print(json.dumps(result))
    else:
        print(result)
