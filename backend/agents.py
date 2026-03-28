import json
import os
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypedDict

import numpy as np

from fea_pipeline import _get_material_properties, _normalize_vector, run_fenicsx_simulation

try:
    from langgraph.graph import END, StateGraph
except Exception as exc:  # pragma: no cover
    StateGraph = None
    END = "END"
    _LANGGRAPH_IMPORT_ERROR = str(exc)
else:
    _LANGGRAPH_IMPORT_ERROR = ""


BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
MEMORY_DB_PATH = BASE_DIR / "foundry_memory.db"


class PipelineState(TypedDict, total=False):
    session_id: str
    stl_filename: str
    forces: list[dict[str, Any]]
    painted_faces: list[dict[str, Any]]
    resolution: str
    part_context: dict[str, Any]

    geometry_analysis: dict[str, Any]
    boundary_conditions: dict[str, Any]
    simulation_result: dict[str, Any]
    failure_report: dict[str, Any]

    iteration_history: list[dict[str, Any]]
    iteration_number: int
    redesign_recommendations: list[dict[str, Any]]


@dataclass
class MemoryAgentStore:
    db_path: Path

    def __post_init__(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS iterations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    iteration_number INTEGER NOT NULL,
                    stl_filename TEXT NOT NULL,
                    forces_json TEXT NOT NULL,
                    simulation_result_json TEXT NOT NULL,
                    redesign_recommendations_json TEXT NOT NULL,
                    created_utc TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_iterations_session ON iterations(session_id, iteration_number)"
            )

    def load_iterations(self, session_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT iteration_number, stl_filename, forces_json, simulation_result_json,
                       redesign_recommendations_json, created_utc
                FROM iterations
                WHERE session_id = ?
                ORDER BY iteration_number ASC
                """,
                (session_id,),
            ).fetchall()

        history: list[dict[str, Any]] = []
        for row in rows:
            history.append(
                {
                    "iteration_number": int(row["iteration_number"]),
                    "stl_filename": row["stl_filename"],
                    "forces": json.loads(row["forces_json"]),
                    "simulation_result": json.loads(row["simulation_result_json"]),
                    "redesign_recommendations": json.loads(row["redesign_recommendations_json"]),
                    "created_utc": row["created_utc"],
                }
            )
        return history

    def save_iteration(
        self,
        session_id: str,
        iteration_number: int,
        stl_filename: str,
        forces: list[dict[str, Any]],
        simulation_result: dict[str, Any],
        redesign_recommendations: list[dict[str, Any]],
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO iterations (
                    session_id, iteration_number, stl_filename,
                    forces_json, simulation_result_json, redesign_recommendations_json, created_utc
                ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                """,
                (
                    session_id,
                    int(iteration_number),
                    stl_filename,
                    json.dumps(forces),
                    json.dumps(simulation_result),
                    json.dumps(redesign_recommendations),
                ),
            )


def _stl_mesh_stats(stl_path: Path) -> dict[str, Any]:
    triangle_count = 0
    bbox_min = [0.0, 0.0, 0.0]
    bbox_max = [0.0, 0.0, 0.0]
    dims = [0.0, 0.0, 0.0]
    estimated_volume = 0.0

    try:
        import trimesh

        mesh = trimesh.load_mesh(stl_path.as_posix(), force="mesh")
        if mesh is not None and hasattr(mesh, "vertices"):
            verts = np.asarray(mesh.vertices, dtype=float)
            if len(verts):
                bbox_min = np.min(verts, axis=0).tolist()
                bbox_max = np.max(verts, axis=0).tolist()
                dims = (np.array(bbox_max) - np.array(bbox_min)).tolist()
            triangle_count = int(len(getattr(mesh, "faces", [])))

            vol = float(abs(getattr(mesh, "volume", 0.0)))
            if vol > 1e-9:
                estimated_volume = vol
            else:
                estimated_volume = float(max(dims[0] * dims[1] * dims[2] * 0.35, 0.0))
    except Exception:
        # Lightweight fallback for environments without trimesh.
        text = stl_path.read_text(encoding="utf-8", errors="ignore").lower()
        triangle_count = text.count("facet normal")

    return {
        "triangle_count": int(triangle_count),
        "bbox_min": [float(v) for v in bbox_min],
        "bbox_max": [float(v) for v in bbox_max],
        "bbox_dimensions": [float(v) for v in dims],
        "estimated_volume": float(estimated_volume),
    }


def _risk_features_from_dims(dims: list[float]) -> list[dict[str, Any]]:
    dims_arr = np.array([max(float(v), 1e-9) for v in dims], dtype=float)
    dmin = float(np.min(dims_arr))
    dmax = float(np.max(dims_arr))
    slenderness = dmax / dmin if dmin > 1e-9 else 0.0

    risks: list[dict[str, Any]] = []
    if slenderness >= 8.0:
        risks.append(
            {
                "feature": "slender_member",
                "severity": "high",
                "detail": f"High aspect ratio detected ({slenderness:.2f}).",
            }
        )

    if dmin < 2.0:
        risks.append(
            {
                "feature": "thin_section",
                "severity": "high",
                "detail": f"Minimum thickness is very small ({dmin:.3f}).",
            }
        )
    elif dmin < 5.0:
        risks.append(
            {
                "feature": "thin_section",
                "severity": "medium",
                "detail": f"Potentially thin region detected ({dmin:.3f}).",
            }
        )

    if not risks:
        risks.append(
            {
                "feature": "geometry_general",
                "severity": "low",
                "detail": "No obvious high-risk geometric feature detected by heuristic checks.",
            }
        )

    return risks


def geometry_agent(state: PipelineState) -> PipelineState:
    stl_filename = str(state.get("stl_filename", "")).strip()
    stl_path = UPLOAD_DIR / stl_filename
    if not stl_filename or not stl_path.exists():
        raise RuntimeError("GeometryAgent: STL file not found")

    stats = _stl_mesh_stats(stl_path)
    risks = _risk_features_from_dims(stats.get("bbox_dimensions", [0.0, 0.0, 0.0]))

    state["geometry_analysis"] = {
        **stats,
        "risk_features": risks,
    }
    return state


def boundary_condition_agent(state: PipelineState) -> PipelineState:
    forces = list(state.get("forces", []))
    painted_faces = list(state.get("painted_faces", []))

    if not painted_faces:
        painted_faces = [
            {
                "region_id": int(f.get("region_id", idx)),
                "normal": f.get("normal", [0.0, 0.0, 1.0]),
                "centroid": f.get("centroid", [0.0, 0.0, 0.0]),
                "paintedArea": float(f.get("paintedArea", f.get("area", 0.0))),
            }
            for idx, f in enumerate(forces)
        ]

    face_by_region = {int(face.get("region_id", idx)): face for idx, face in enumerate(painted_faces)}

    normalized_forces: list[dict[str, Any]] = []
    missing_regions: list[int] = []

    for idx, force in enumerate(forces):
        region_id = int(force.get("region_id", idx))
        face = face_by_region.get(region_id)
        if face is None:
            missing_regions.append(region_id)
            continue

        normalized_forces.append(
            {
                **force,
                "region_id": region_id,
                "direction": _normalize_vector(force.get("direction", [0.0, 0.0, -1.0])),
                "paintedArea": float(face.get("paintedArea", face.get("area", force.get("paintedArea", 0.0)))),
                "area": float(face.get("paintedArea", face.get("area", force.get("paintedArea", 0.0)))),
                "centroid": face.get("centroid", force.get("centroid", [0.0, 0.0, 0.0])),
                "normal": face.get("normal", force.get("normal", [0.0, 0.0, 1.0])),
            }
        )

    if missing_regions:
        raise RuntimeError(f"BoundaryConditionAgent: missing painted faces for regions {missing_regions}")

    state["boundary_conditions"] = {
        "forces": normalized_forces,
        "painted_faces": painted_faces,
        "validated": True,
    }
    return state


def simulation_agent(state: PipelineState) -> PipelineState:
    stl_filename = str(state.get("stl_filename", "")).strip()
    stl_path = UPLOAD_DIR / stl_filename
    if not stl_path.exists():
        raise RuntimeError("SimulationAgent: STL file not found")

    bc = state.get("boundary_conditions", {})
    result = run_fenicsx_simulation(
        stl_path=stl_path,
        forces=list(bc.get("forces", [])),
        resolution=str(state.get("resolution", "high")),
        part_context=dict(state.get("part_context", {})),
    )
    state["simulation_result"] = result
    return state


def _cluster_top_stress_zones(
    stress_points: list[dict[str, Any]],
    top_k: int = 3,
) -> list[dict[str, Any]]:
    if not stress_points:
        return []

    points = np.array([[float(p.get("x", 0.0)), float(p.get("y", 0.0)), float(p.get("z", 0.0))] for p in stress_points])
    stresses = np.array([float(p.get("stress", 0.0)) for p in stress_points])

    bbox_min = np.min(points, axis=0)
    bbox_max = np.max(points, axis=0)
    diag = float(np.linalg.norm(bbox_max - bbox_min))
    radius = max(diag * 0.08, 1e-6)

    sorted_idx = np.argsort(stresses)[::-1]
    used = np.zeros(len(points), dtype=bool)
    zones: list[dict[str, Any]] = []

    for idx in sorted_idx:
        if used[idx]:
            continue

        center = points[idx]
        dists = np.linalg.norm(points - center, axis=1)
        cluster_mask = dists <= radius
        if np.sum(cluster_mask) == 0:
            continue

        used = used | cluster_mask
        cluster_stresses = stresses[cluster_mask]
        cluster_points = points[cluster_mask]

        zones.append(
            {
                "center": [float(v) for v in np.mean(cluster_points, axis=0)],
                "max_stress": float(np.max(cluster_stresses)),
                "avg_stress": float(np.mean(cluster_stresses)),
                "point_count": int(np.sum(cluster_mask)),
            }
        )

        if len(zones) >= top_k:
            break

    return zones


def analysis_agent(state: PipelineState) -> PipelineState:
    result = dict(state.get("simulation_result", {}))
    stress_points = list(result.get("stress_points", []))

    material = str(state.get("part_context", {}).get("material", "aluminum"))
    mat = _get_material_properties(material)
    yield_strength = float(mat.get("yield", 2.75e8))

    zones = _cluster_top_stress_zones(stress_points, top_k=3)
    failure_zones: list[dict[str, Any]] = []

    for i, zone in enumerate(zones, start=1):
        local_max = float(zone["max_stress"])
        local_sf = float("inf") if local_max <= 1e-9 else float(yield_strength / local_max)
        passed = local_sf >= 2.0
        failure_margin = max(0.0, 2.0 - local_sf)

        zone_report = {
            "zone_id": i,
            "center": zone["center"],
            "max_stress": local_max,
            "avg_stress": float(zone["avg_stress"]),
            "local_safety_factor": local_sf,
            "failed": (not passed),
            "failure_margin_to_sf2": failure_margin,
        }
        if zone_report["failed"]:
            failure_zones.append(zone_report)
        zones[i - 1] = zone_report

    state["failure_report"] = {
        "material": material,
        "yield_strength": yield_strength,
        "zones": zones,
        "failed_zones": failure_zones,
        "failed_zone_count": len(failure_zones),
    }
    return state


def memory_agent(state: PipelineState) -> PipelineState:
    session_id = str(state.get("session_id", "")).strip() or str(uuid.uuid4())
    state["session_id"] = session_id

    store = MemoryAgentStore(MEMORY_DB_PATH)
    history = store.load_iterations(session_id)

    state["iteration_history"] = history
    state["iteration_number"] = len(history) + 1
    return state


def _gemini_recommendations(
    failure_report: dict[str, Any],
    history: list[dict[str, Any]],
    api_key: str,
) -> list[dict[str, Any]]:
    if not api_key:
        return []

    prompt = (
        "You are a structural redesign assistant. "
        "Return exactly 3 recommendations as a JSON array with objects containing keys: "
        "zone_description, specific_change, expected_improvement. "
        "No markdown, no extra text.\n\n"
        f"Failure report:\n{json.dumps(failure_report)}\n\n"
        f"Iteration history:\n{json.dumps(history)}"
    )

    try:
        import google.generativeai as genai

        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-2.5-flash")
        response = model.generate_content(prompt)
        parsed = json.loads((response.text or "[]").strip())
        if not isinstance(parsed, list):
            return []
        cleaned: list[dict[str, Any]] = []
        for item in parsed[:3]:
            if not isinstance(item, dict):
                continue
            cleaned.append(
                {
                    "zone_description": str(item.get("zone_description", "")).strip(),
                    "specific_change": str(item.get("specific_change", "")).strip(),
                    "expected_improvement": str(item.get("expected_improvement", "")).strip(),
                }
            )
        return cleaned
    except Exception:
        return []


def _fallback_recommendations(failure_report: dict[str, Any]) -> list[dict[str, Any]]:
    zones = list(failure_report.get("zones", []))[:3]
    if not zones:
        return [
            {
                "zone_description": "Global structure",
                "specific_change": "Increase wall thickness by 10-15% near force paths.",
                "expected_improvement": "Lower peak stress and increase global safety factor.",
            },
            {
                "zone_description": "Force application interfaces",
                "specific_change": "Add fillets and increase local support area where loads are applied.",
                "expected_improvement": "Reduce stress concentration and smooth local gradients.",
            },
            {
                "zone_description": "Load-bearing spans",
                "specific_change": "Add one reinforcing rib along the primary bending direction.",
                "expected_improvement": "Increase stiffness and reduce bending stress in critical zones.",
            },
        ]

    recs: list[dict[str, Any]] = []
    for z in zones:
        center = z.get("center", [0.0, 0.0, 0.0])
        recs.append(
            {
                "zone_description": f"Zone around ({center[0]:.2f}, {center[1]:.2f}, {center[2]:.2f})",
                "specific_change": "Increase local thickness and add a blend radius at adjacent transitions.",
                "expected_improvement": "Reduce local von Mises peak and improve local safety factor toward >= 2.0.",
            }
        )

    while len(recs) < 3:
        recs.append(
            {
                "zone_description": "Secondary support region",
                "specific_change": "Add a lightweight reinforcing rib tied into the nearest support path.",
                "expected_improvement": "Distribute load more evenly and reduce hotspot stress.",
            }
        )

    return recs[:3]


def redesign_agent(state: PipelineState) -> PipelineState:
    failure_report = dict(state.get("failure_report", {}))
    history = list(state.get("iteration_history", []))
    api_key = os.getenv("GEMINI_API_KEY", "")

    recs = _gemini_recommendations(failure_report=failure_report, history=history, api_key=api_key)
    if len(recs) != 3:
        recs = _fallback_recommendations(failure_report)

    state["redesign_recommendations"] = recs[:3]

    # Save current iteration after full pipeline completion, including recommendations.
    store = MemoryAgentStore(MEMORY_DB_PATH)
    store.save_iteration(
        session_id=str(state.get("session_id", "")),
        iteration_number=int(state.get("iteration_number", 1)),
        stl_filename=str(state.get("stl_filename", "")),
        forces=list(state.get("forces", [])),
        simulation_result=dict(state.get("simulation_result", {})),
        redesign_recommendations=list(state.get("redesign_recommendations", [])),
    )
    return state


def build_agent_graph():
    if StateGraph is None:
        raise RuntimeError(f"LangGraph import failed: {_LANGGRAPH_IMPORT_ERROR}")

    graph = StateGraph(PipelineState)
    graph.add_node("GeometryAgent", geometry_agent)
    graph.add_node("BoundaryConditionAgent", boundary_condition_agent)
    graph.add_node("SimulationAgent", simulation_agent)
    graph.add_node("AnalysisAgent", analysis_agent)
    graph.add_node("MemoryAgent", memory_agent)
    graph.add_node("RedesignAgent", redesign_agent)

    graph.set_entry_point("GeometryAgent")
    graph.add_edge("GeometryAgent", "BoundaryConditionAgent")
    graph.add_edge("BoundaryConditionAgent", "SimulationAgent")
    graph.add_edge("SimulationAgent", "AnalysisAgent")
    graph.add_edge("AnalysisAgent", "MemoryAgent")
    graph.add_edge("MemoryAgent", "RedesignAgent")
    graph.add_edge("RedesignAgent", END)
    return graph.compile()


def run_agent_pipeline(
    stl_filename: str,
    forces: list[dict[str, Any]],
    resolution: str,
    part_context: dict[str, Any] | None,
    session_id: str,
    painted_faces: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    app = build_agent_graph()
    state: PipelineState = {
        "session_id": session_id,
        "stl_filename": stl_filename,
        "forces": forces,
        "painted_faces": painted_faces or [],
        "resolution": resolution,
        "part_context": part_context or {},
    }
    out: PipelineState = app.invoke(state)

    simulation_result = dict(out.get("simulation_result", {}))
    simulation_result["redesign_recommendations"] = list(out.get("redesign_recommendations", []))
    simulation_result["iteration_number"] = int(out.get("iteration_number", 1))
    simulation_result["failure_report"] = dict(out.get("failure_report", {}))
    simulation_result["geometry_analysis"] = dict(out.get("geometry_analysis", {}))
    return simulation_result
