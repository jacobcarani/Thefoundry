import json
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
CALIBRATION_PATH = BASE_DIR / "models" / "fea_calibration.json"

_DEFAULT_STATE = {
    "version": 1,
    "synthetic_target_pa": 5_000_000.0,
    "last_calibration_utc": None,
    "synthetic_runs_since_calibration": 0,
    "calibration_history": [],
}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_calibration_state() -> dict:
    if not CALIBRATION_PATH.exists():
        return dict(_DEFAULT_STATE)

    try:
        state = json.loads(CALIBRATION_PATH.read_text(encoding="utf-8"))
        merged = dict(_DEFAULT_STATE)
        merged.update(state)
        if not isinstance(merged.get("calibration_history"), list):
            merged["calibration_history"] = []
        return merged
    except Exception:
        return dict(_DEFAULT_STATE)


def save_calibration_state(state: dict) -> None:
    CALIBRATION_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def get_synthetic_target_pa() -> float:
    state = load_calibration_state()
    target = float(state.get("synthetic_target_pa", _DEFAULT_STATE["synthetic_target_pa"]))
    return max(1.0e4, min(target, 2.0e9))


def register_synthetic_run(interval: int = 5) -> bool:
    state = load_calibration_state()
    state["synthetic_runs_since_calibration"] = int(state.get("synthetic_runs_since_calibration", 0)) + 1
    should_calibrate = state["synthetic_runs_since_calibration"] >= max(1, int(interval))
    save_calibration_state(state)
    return should_calibrate


def apply_calibration_update(new_target_pa: float, calibration_info: dict) -> dict:
    state = load_calibration_state()

    state["synthetic_target_pa"] = float(max(1.0e4, min(new_target_pa, 2.0e9)))
    state["last_calibration_utc"] = _utc_now_iso()
    state["synthetic_runs_since_calibration"] = 0

    history = state.get("calibration_history", [])
    history.append(
        {
            "timestamp_utc": state["last_calibration_utc"],
            "target_pa": state["synthetic_target_pa"],
            "details": calibration_info,
        }
    )
    state["calibration_history"] = history[-30:]

    save_calibration_state(state)
    return state
